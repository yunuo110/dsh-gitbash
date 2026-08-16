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

/** Gate message shown when Git Bash cannot start under a restricted sandbox. */
function gateMessage(mode) {
  return `${name}: the Git-for-Windows bash runtime cannot start inside the "${mode ?? 'unknown'}" sandbox `
    + '(the MSYS runtime cannot create its signal pipes under the restricted token). '
    + 'Retry this exact command once with sandbox_permissions: "danger-full-access" plus a justification, '
    + 'or ask the user to switch the session sandbox mode to full access.'
}

/** Fuse upstream cancellation with an identifiable timeout. */
function timeoutSignal(upstream, timeoutMs) {
  const timer = new AbortController()
  const id = setTimeout(() => {
    timer.abort(new Error('BASH_TIMEOUT'))
  }, timeoutMs)
  const signal = upstream === undefined
    ? timer.signal
    : AbortSignal.any([upstream, timer.signal])
  return {
    signal,
    timedOut: () => timer.signal.aborted,
    dispose: () => clearTimeout(id),
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

  const resolved = resolveConfig(config)
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new Error(`${name}: ctx.subprocess is unavailable`)
  }
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (resolved.shellPath === undefined) {
    ctx.logger?.warn?.(`${name}: Git Bash executable not found; bash tool will fail until shellPath is configured`)
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
    const shellPath = resolved.shellPath ?? 'bash'
    try {
      return subprocess.spawn(spawnSpec(
        spec,
        buildArgv(shellPath, spec.command),
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
      const stdoutMaxBytes = request.stdoutMaxBytes ?? resolved.maxOutputBytes
      if (!Number.isFinite(stdoutMaxBytes) || stdoutMaxBytes <= 0) {
        throw new Error(`${name}: request.stdoutMaxBytes must be a positive finite number`)
      }
      return {
        command: request.command,
        workdir: toWindowsPath(request.workdir ?? resolved.cwd ?? process.cwd()),
        timeoutMs,
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

    async run(spec) {
      const mode = spec.sandboxPolicy?.mode
      // `undefined` means the deployment carries no sandbox policy at all.
      if (mode !== undefined && mode !== 'danger-full-access') {
        throw new Error(gateMessage(mode))
      }
      const fused = timeoutSignal(spec.signal, spec.timeoutMs)
      try {
        const handle = spawnShell(spec, spec.stdoutMaxBytes, fused.signal)
        let outcome
        try {
          outcome = await handle.done
        } catch (error) {
          throw spawnError(resolved.shellPath ?? 'bash', spec.workdir, error)
        }
        const stdout = finalOutput(handle.collected.stdout)
        const stderr = finalOutput(handle.collected.stderr)
        const timedOut = fused.timedOut()
        const aborted = spec.signal !== undefined && spec.signal.aborted && !timedOut
        return {
          ...outcome,
          timedOut,
          aborted,
          timeoutMs: spec.timeoutMs,
          stdout,
          stderr,
          ...(mode === undefined ? {} : { sandbox: { mode, denied: false } }),
        }
      } finally {
        fused.dispose()
      }
    },

    start(spec) {
      const mode = spec.sandboxPolicy?.mode
      if (mode !== undefined && mode !== 'danger-full-access') {
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
          spawnFailureNote = spawnError(resolved.shellPath ?? 'bash', spec.workdir, error).message
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
