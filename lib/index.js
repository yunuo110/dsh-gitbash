/**
 * dsh-gitbash — DeepSeek Harness bundle plugin (Reasonix-style refactor).
 *
 * On Windows this plugin:
 *   1. provides the `ctx.shell` capability seam with a Git-for-Windows bash
 *      executor, so the existing `bash` tool runs `bash.exe -lc <command>`;
 *   2. hides `pwsh` (and the old separate `gitbash` tool) from the prompt;
 *   3. rewrites the existing `bash` tool description to Git Bash/MSYS2 rules;
 *   4. denies `pwsh`/legacy `gitbash` execution as a safety net.
 *
 * This is intentionally token-frugal: there is no extra `gitbash` tool schema
 * and no extra system-prompt section. The model sees the same single `bash`
 * tool, just pointed at Git Bash on Windows.
 *
 * Sandbox note: the MSYS runtime cannot initialize inside the Windows
 * restricted-token sandbox, so commands are gated on danger-full-access. The
 * standard DSH sandbox_permissions/justification escalation flow remains
 * handled by the upstream `tool-bash` plugin through this executor.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import {
  BASH_TOOL_DESCRIPTION,
  buildArgv,
  filterShellTools,
  LEGACY_GITBASH_TOOL_NAME,
  resolveConfig,
  toWindowsPath,
} from './gitbash-core.mjs'

/** Cordis plugin name used by loader diagnostics and patch rows. */
export const name = 'dsh-gitbash'

/** Required host services; ordering matters because apply() reads them eagerly. */
export const inject = ['tools', 'subprocess', 'sandboxPolicy']

/** Node's maximum timer delay before setTimeout clamps to 1ms. */
const MAX_TIMER_DELAY_MS = 2147483647

const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  // Force Python and common Unix tools to emit UTF-8 on Windows, avoiding
  // GBK mojibake and UnicodeEncodeError when output contains CJK/emoji.
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
}

/** Resolve the native Windows PowerShell executable for host-level shell calls. */
function windowsPowerShellPath() {
  const programFiles = process.env.ProgramFiles
  const pwsh = programFiles === undefined ? undefined : `${programFiles}\\PowerShell\\7\\pwsh.exe`
  if (pwsh !== undefined && existsSync(pwsh)) return pwsh
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * Ask the registry where Git for Windows is installed. Standard Git for Windows
 * installers register `HKLM\SOFTWARE\GitForWindows\InstallPath`, which is the
 * only reliable way to find a non-default root such as `D:\Git\Git`.
 */
function gitForWindowsInstallPath() {
  try {
    const output = execFileSync((process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows') + '\\System32\\reg.exe', ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    const match = /InstallPath\s+REG_SZ\s+(.+)/i.exec(output)
    if (match === null) return undefined
    const installPath = match[1].trim()
    return installPath.length === 0 ? undefined : installPath
  } catch {
    // Missing key, no reg.exe, or a policy that blocks it: fall back to PATH probing.
    return undefined
  }
}

/** Gate message shown when Git Bash cannot start under a restricted sandbox. */
function gateMessage(mode) {
  return `${name}: the Git-for-Windows bash runtime cannot start inside the "${mode ?? 'unknown'}" sandbox `
    + '(the MSYS runtime cannot create its signal pipes under the restricted token). '
    + 'Retry this exact command once with sandbox_permissions: "danger-full-access" plus a justification, '
    + 'or ask the user to switch the session sandbox mode to full access.'
}

/** One first-cause cancellation signal for both foreground and retained jobs. */
function executionSignal(upstream, timeoutMs, onExpiry) {
  const controller = new AbortController()
  let firstCause
  const abort = (cause, reason) => {
    if (controller.signal.aborted) return
    firstCause = cause
    controller.abort(reason)
  }
  const onCallerAbort = () => abort('aborted', upstream.reason)
  if (upstream !== undefined) {
    if (upstream.aborted) onCallerAbort()
    else upstream.addEventListener('abort', onCallerAbort, { once: true })
  }
  const timer = onExpiry === 'kill'
    ? setTimeout(() => abort('timedOut', new Error('BASH_TIMEOUT')), timeoutMs)
    : undefined
  return {
    signal: controller.signal,
    classify: () => ({
      timedOut: firstCause === 'timedOut',
      aborted: firstCause === 'aborted',
    }),
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
      upstream?.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** Project a settled subprocess collector into the tool result shape. */
function finalOutput(reader) {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
  }
}

/** Wrap a spawn failure with the shell path and workdir that caused it. */
function spawnError(shellPath, workdir, cause) {
  return new Error(`${name}: failed to start ${shellPath} (workdir: ${workdir}): ${cause?.message ?? String(cause)}`, {
    cause,
  })
}

/**
 * Register the Git Bash shell provider and the prompt/guard layers.
 * Only meaningful on Windows; other platforms no-op.
 */
export function apply(ctx, config = {}) {
  if (process.platform !== 'win32') {
    ctx.logger?.info?.(`${name}: only meaningful on win32; skipping`)
    return
  }

  // Explicit paths should not synchronously query the registry at plugin startup.
  const explicitPath = typeof config?.shellPath === 'string' && config.shellPath.trim().length > 0
  const envPath = typeof process.env.GIT_BASH === 'string' && process.env.GIT_BASH.trim().length > 0
  const installPath = explicitPath || envPath ? undefined : gitForWindowsInstallPath()
  const extraCandidates = installPath === undefined ? [] : [`${installPath}\\bin\\bash.exe`]
  const resolved = resolveConfig(config, process.env, process.platform, extraCandidates)
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new Error(`${name}: ctx.subprocess is unavailable`)
  }
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (resolved.shellPath === undefined) {
    ctx.logger?.warn?.(
      `${name}: Git Bash executable not found; set config shellPath (e.g. 'D:\\Git\\Git\\bin\\bash.exe') `
      + 'or the GIT_BASH environment variable, otherwise the bash tool will refuse to run '
      + '(the WSL forwarder is deliberately not used).',
    )
  }

  const spawnSpec = (spec, argv, stdoutMaxBytes, signal) => ({
    argv,
    cwd: spec.workdir,
    stdio: {
      stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
      stdout: { maxBytes: stdoutMaxBytes, spill: { maxBytes: resolved.maxSpillBytes } },
      stderr: { maxBytes: resolved.maxOutputBytes, spill: { maxBytes: resolved.maxSpillBytes } },
    },
    graceMs: resolved.graceMs,
    signal,
    env: {
      ...ENV_OVERRIDES,
      ...spec.env,
      ...spec.dshEnv,
    },
  })

  const spawnShell = (spec, stdoutMaxBytes, signal) => {
    // Session-scoped bash tool calls carry a sandboxPolicy and must run Git
    // Bash. Host-level callers (e.g. dsh-opencode-go-usage) do not carry one
    // and on Windows expect the native PowerShell interpreter, so dispatch
    // them to PowerShell instead of trying to parse PowerShell with bash.
    const isSessionBash = spec.sandboxPolicy !== undefined
    // Never fall back to a bare `bash`: on Windows that resolves to
    // C:\Windows\System32\bash.exe, the WSL forwarder, which silently drops
    // shell variables and quoting. Fail loudly instead.
    if (isSessionBash && resolved.shellPath === undefined) {
      throw new Error(
        `${name}: Git Bash executable not found. Install Git for Windows, set the GIT_BASH environment variable, `
        + 'or set this plugin\'s config `shellPath` (e.g. \'D:\\\\Git\\\\Git\\\\bin\\\\bash.exe\').',
      )
    }
    const shellPath = isSessionBash ? resolved.shellPath : windowsPowerShellPath()
    const argv = isSessionBash
      ? buildArgv(shellPath, spec.command)
      : [shellPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', spec.command]
    try {
      return subprocess.spawn(spawnSpec(
        spec,
        argv,
        stdoutMaxBytes,
        signal,
      ))
    } catch (error) {
      throw spawnError(shellPath, spec.workdir, error)
    }
  }

  const executor = {
    /** Advertise confinement so the bash tool offers per-call escalation. */
    get sandboxMode() {
      return sandboxPolicy === undefined ? undefined : sandboxPolicy.defaultMode
    },

    resolve(request) {
      const timeoutMs = Math.min(request.timeoutMs ?? resolved.timeoutMs, resolved.maxTimeoutMs)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`${name}: request.timeoutMs must be a positive finite number`)
      }
      const onExpiry = request.onExpiry ?? 'kill'
      if (onExpiry !== 'kill' && onExpiry !== 'none') {
        throw new Error(`${name}: request.onExpiry must be "kill" or "none"`)
      }
      const stdoutMaxBytes = request.stdoutMaxBytes ?? resolved.maxOutputBytes
      if (!Number.isFinite(stdoutMaxBytes) || stdoutMaxBytes <= 0) {
        throw new Error(`${name}: request.stdoutMaxBytes must be a positive finite number`)
      }
      return {
        command: request.command,
        workdir: toWindowsPath(request.workdir ?? resolved.cwd ?? process.cwd()),
        timeoutMs,
        onExpiry,
        stdoutMaxBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
        // Only session-scoped callers (the bash tool) pass a sandboxPolicy.
        // Host plugins that use ctx.shell without a session are trusted host
        // code and should not inherit the process-default workspace-write
        // gate, which would break them under full-access sessions.
        ...(request.sandboxPolicy === undefined ? {} : { sandboxPolicy: request.sandboxPolicy }),
      }
    },

    /** Legacy run() projects the same single execution used by newer desktop cores. */
    async run(spec) {
      return (await executor.execute(spec)).result()
    },

    /**
     * Unified shell execution: spawn eagerly, retain the live process handle,
     * and memoize the foreground result without running a command twice.
     * onExpiry:'none' never arms a timer (the job registry owns its wait).
     */
    async execute(spec) {
      const mode = spec.sandboxPolicy?.mode
      if (spec.sandboxPolicy !== undefined && mode !== 'danger-full-access') {
        throw new Error(gateMessage(mode))
      }
      if (spec.signal?.aborted) {
        throw spec.signal.reason ?? new Error('dsh-gitbash: command aborted before execution')
      }
      const fused = executionSignal(spec.signal, spec.timeoutMs, spec.onExpiry ?? 'kill')
      let running
      let syncError
      try {
        running = spawnShell(spec, spec.stdoutMaxBytes, fused.signal)
      } catch (error) {
        syncError = error
      }
      const emptyReader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
      const stdout = running?.collected?.stdout ?? emptyReader
      const stderr = running?.collected?.stderr ?? emptyReader
      let providerFailed = false
      let providerError
      let providerFailureNote
      let providerNoteDelivered = false
      const recordFailure = (error) => {
        providerFailed = true
        providerError = error
        let detail = 'unprintable provider failure'
        try { detail = String(error) } catch { /* untrusted provider error */ }
        providerFailureNote = 'subprocess failed before reporting an outcome: ' + detail
      }
      const observedStderr = {
        readFrom: (offset) => {
          if (providerFailureNote === undefined) return stderr.readFrom(offset)
          const note = Buffer.from(providerFailureNote, 'utf8')
          return {
            text: note.subarray(Math.min(offset, note.length)).toString('utf8'),
            nextOffset: note.length,
            lossy: false,
          }
        },
      }
      const spawned = running === undefined ? Promise.reject(syncError) : running.done
      let stdoutOffset = 0
      let stderrOffset = 0
      let resultPromise
      const proc = {
        status: 'running',
        exitCode: null,
        signal: null,
        observed: { stdout, stderr: observedStderr },
        done: spawned.then((outcome) => {
          if (proc.status === 'running') {
            proc.status = fused.signal.aborted || outcome.signal !== null ? 'killed' : 'completed'
          }
          proc.exitCode = outcome.exitCode
          proc.signal = outcome.signal
          if (mode !== undefined) proc.sandbox = { mode, denied: false }
          fused.dispose()
        }, (error) => {
          const cancelled = proc.status === 'killed' || fused.signal.aborted
          proc.status = 'killed'
          if (running === undefined || !cancelled) recordFailure(error)
          if (mode !== undefined) proc.sandbox = { mode, denied: false }
          fused.dispose()
        }),
        readOutput: () => {
          const out = stdout.readFrom(stdoutOffset)
          const err = stderr.readFrom(stderrOffset)
          stdoutOffset = out.nextOffset
          stderrOffset = err.nextOffset
          const failure = providerFailureNote !== undefined && !providerNoteDelivered
            ? providerFailureNote : ''
          if (failure.length > 0) providerNoteDelivered = true
          const errSep = err.text.length > 0 && !err.text.endsWith('\n') ? '\n' : ''
          const errText = err.text + (failure.length > 0 ? errSep + failure : '')
          const outSep = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
          return {
            delta: out.text + (errText.length > 0 ? outSep + '[stderr]\n' + errText : ''),
            lossy: out.lossy || err.lossy,
            ...(out.spillPath === undefined ? {} : { stdoutSpillPath: out.spillPath }),
            ...(err.spillPath === undefined ? {} : { stderrSpillPath: err.spillPath }),
          }
        },
        kill: () => {
          if (proc.status !== 'running') return false
          proc.status = 'killed'
          running?.terminate()
          return true
        },
        result: () => {
          resultPromise ??= proc.done.then(() => {
            if (providerFailed) throw providerError
            return {
              exitCode: proc.exitCode,
              signal: proc.signal,
              ...fused.classify(),
              timeoutMs: spec.timeoutMs,
              stdout: finalOutput(stdout),
              stderr: finalOutput(stderr),
              ...(mode === undefined ? {} : { sandbox: proc.sandbox }),
            }
          })
          return resultPromise
        },
      }
      return proc
    },

    start(spec) {
      const mode = spec.sandboxPolicy?.mode
      if (spec.sandboxPolicy !== undefined && mode !== 'danger-full-access') {
        throw new Error(gateMessage(mode))
      }
      const running = spawnShell(spec, resolved.maxOutputBytes, spec.signal)
      const collected = {
        stdout: running.collected.stdout,
        stderr: running.collected.stderr,
      }
      let spawnFailureNote
      const consumeSpawnFailure = () => {
        const note = spawnFailureNote ?? ''
        spawnFailureNote = undefined
        return note
      }
      let stdoutOffset = 0
      let stderrOffset = 0
      const proc = {
        status: 'running',
        exitCode: null,
        signal: null,
        done: running.done.then((outcome) => {
          if (proc.status === 'running') {
            proc.status = spec.signal?.aborted === true || outcome.signal !== null
              ? 'killed'
              : 'completed'
          }
          proc.exitCode = outcome.exitCode
          proc.signal = outcome.signal
        }, (error) => {
          proc.status = 'killed'
          spawnFailureNote = spawnError(resolved.shellPath ?? 'Git Bash', spec.workdir, error).message
        }),
        readOutput: () => {
          const out = collected.stdout.readFrom(stdoutOffset)
          const err = collected.stderr.readFrom(stderrOffset)
          stdoutOffset = out.nextOffset
          stderrOffset = err.nextOffset
          const errText = err.text.length > 0 ? err.text : consumeSpawnFailure()
          const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
          return {
            delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
            lossy: out.lossy || err.lossy,
            ...(out.spillPath === undefined ? {} : { stdoutSpillPath: out.spillPath }),
            ...(err.spillPath === undefined ? {} : { stderrSpillPath: err.spillPath }),
          }
        },
        kill: () => {
          if (proc.status !== 'running') return false
          proc.status = 'killed'
          running.terminate()
          return true
        },
      }
      return proc
    },
  }

  ctx.provide('shell', executor)

  // The model sees the existing `bash` tool, rewritten for Git Bash, and no
  // longer sees pwsh or the old separate gitbash tool.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    if (!assembled || !Array.isArray(assembled.tools)) return assembled
    let changed = false
    const tools = filterShellTools(assembled.tools)
    if (tools !== assembled.tools) changed = true
    const rewritten = tools.map((tool) => {
      if (tool?.name !== 'bash') return tool
      changed = true
      return { ...tool, description: BASH_TOOL_DESCRIPTION }
    })
    return changed ? { ...assembled, tools: rewritten } : assembled
  })

  // Safety net: block pwsh and the old gitbash tool even if a stale catalog
  // still exposes them.
  ctx.tools.guard((exec) => {
    if (exec?.name === 'pwsh' || exec?.name === LEGACY_GITBASH_TOOL_NAME) {
      return `${name}: pwsh and the legacy gitbash tool are disabled on Windows; use the bash tool instead.`
    }
    return undefined
  })
}
