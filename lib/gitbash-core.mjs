/**
 * gitbash-core — pure helpers for the dsh-gitbash bundle plugin.
 *
 * Kept free of DSH package imports so it can be unit-tested without a live
 * DeepSeek Harness profile. The plugin entry point (`./index.js`) imports
 * this module and wires it to the official DSH tool/sandbox/subprocess seams.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** Stable tool name exposed to the model (the single bash tool). */
export const TOOL_NAME = 'bash'

/** Legacy separate tool name, kept only to hide/deny it after the refactor. */
export const LEGACY_GITBASH_TOOL_NAME = 'gitbash'

/** Model-facing description shown for the bash tool on Windows/Git Bash. */
export const BASH_TOOL_DESCRIPTION = `Execute a bash command (Git Bash / Git for Windows bash.exe -lc) and return combined stdout/stderr. Use POSIX/bash syntax, not PowerShell: $VAR, export NAME=value, ls/grep/find/sed/awk, pipes |, redirection > >>, &&/||, command substitution $(...). Paths look like /d/WorkSpace or C:/WorkSpace; avoid raw backslashes unless quoted. PATH includes /usr/bin and /mingw64/bin so git, npm, ssh, and common Unix tools work. Each call spawns a fresh non-interactive shell: no cwd/export/alias state persists between calls — pass workdir or chain stateful steps with &&. Non-zero exits are reported as [exit code: N]; investigate failures before moving on.`

/** Backwards-compatible alias for tests/tools that still import the old name. */
export const GITBASH_TOOL_DESCRIPTION = BASH_TOOL_DESCRIPTION

/** Environment overrides that keep Git Bash output machine-friendly and UTF-8. */
export const ENV_OVERRIDES = {
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

export const DEFAULT_TIMEOUT_MS = 120000
export const MAX_TIMEOUT_MS = 600000
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
export const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024
export const DEFAULT_GRACE_MS = 3000

/**
 * Candidate Git-for-Windows bash locations, in preference order. The
 * System32 `bash.exe` is deliberately excluded: on Windows 10+ that is the
 * WSL forwarder, not Git Bash.
 */
export function candidateGitBashPaths(env = process.env, extra = []) {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = (env.SystemRoot ?? 'C:\\Windows').toLowerCase()
  const localAppData = env.LOCALAPPDATA ?? ''
  const userProfile = env.USERPROFILE ?? ''
  const candidates = [
    env.GIT_BASH,
    ...extra,
    `${programFiles}\\Git\\bin\\bash.exe`,
    env['ProgramFiles(x86)'] === undefined ? undefined : `${env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`,
    env.ProgramW6432 === undefined ? undefined : `${env.ProgramW6432}\\Git\\bin\\bash.exe`,
    localAppData.length > 0 ? `${localAppData}\\Programs\\Git\\bin\\bash.exe` : undefined,
    userProfile.length > 0 ? `${userProfile}\\scoop\\apps\\git\\current\\bin\\bash.exe` : undefined,
  ]
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    if (trimmed.toLowerCase().includes(systemRoot)) continue
    const root = trimmed.replace(/[\\/]+$/, '')
    candidates.push(`${root}\\bash.exe`)
    // Git for Windows puts `git.exe` on PATH via `<GitRoot>\cmd`, but the shell
    // lives in `<GitRoot>\bin\bash.exe`. Derive it so non-standard install
    // roots (e.g. D:\Git\Git) are found without a hardcoded Program Files path.
    const cmdSibling = /^(.*?)[\\/]cmd$/i.exec(root)
    if (cmdSibling !== null) candidates.push(`${cmdSibling[1]}\\bin\\bash.exe`)
    // Some installs put `<GitRoot>\usr\bin` on PATH; the sibling `bin` is there too.
    const usrBinSibling = /^(.*?)[\\/]usr[\\/]bin$/i.exec(root)
    if (usrBinSibling !== null) candidates.push(`${usrBinSibling[1]}\\bin\\bash.exe`)
  }
  // Never fall back to a bare `bash`/System32 `bash.exe`: on Windows 10+ that is
  // the WSL forwarder, which silently mangles quoted arguments (variables come
  // back empty) instead of running Git Bash.
  return candidates.filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
}

/** Resolve the Git Bash executable, or return undefined when not found. */
export function detectGitBashPath(explicit, env = process.env, platform = process.platform, extra = []) {
  if (platform !== 'win32') return undefined
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim()
  for (const candidate of candidateGitBashPaths(env, extra)) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Ignore unreadable candidates and keep probing.
    }
  }
  return undefined
}

/** Build argv for Git for Windows bash. `-lc` mimics a login Git Bash shell. */
export function buildArgv(gitBashPath, command) {
  if (typeof gitBashPath !== 'string' || gitBashPath.length === 0) {
    throw new Error(`${TOOL_NAME}: Git Bash executable is unavailable`)
  }
  return [gitBashPath, '-lc', command]
}

/** Merge DSH environment over stable plain-output overrides. */
export function buildEnv(dshEnv = {}) {
  return { ...ENV_OVERRIDES, ...dshEnv }
}

/** Validate model-supplied arguments before spawning. */
export function validateArgs(args) {
  if (typeof args.command !== 'string' || args.command.trim().length === 0) {
    throw new Error(`${TOOL_NAME}: invalid command — expected a non-empty string`)
  }
  if (typeof args.description !== 'string' || args.description.trim().length === 0) {
    throw new Error(`${TOOL_NAME}: invalid description — expected a non-empty string`)
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`${TOOL_NAME}: invalid timeoutMs — expected a positive number`)
  }
  if ((args.sandbox_permissions === undefined) !== (args.justification === undefined)) {
    throw new Error(`${TOOL_NAME}: sandbox_permissions and justification must be provided together`)
  }
}

/** Clamp a caller timeout to [positive, max]. */
export function clampTimeout(value, fallback = DEFAULT_TIMEOUT_MS, max = MAX_TIMEOUT_MS) {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${TOOL_NAME}: invalid timeoutMs — expected a positive number`)
  }
  return Math.min(value, max)
}

/**
 * Convert an MSYS drive path such as `/d/foo` into `D:\foo` for Node's
 * child_process cwd. Non-drive MSYS paths like `/usr/bin` are left alone.
 */
export function toWindowsPath(value, platform = process.platform) {
  if (platform !== 'win32' || typeof value !== 'string' || value.length === 0) return value
  const match = /^\/\s*([A-Za-z])(?:$|\/(.*))$/.exec(value)
  if (match === null) return value
  const drive = `${match[1].toUpperCase()}:`
  const rest = match[2] ?? ''
  if (rest === '') return `${drive}\\`
  return `${drive}\\${rest.replace(/\//g, '\\')}`
}

/** Resolve the working directory from the model's workdir and session header. */
export function resolveWorkdir(modelWorkdir, exec, platform = process.platform) {
  const headerCwd = exec?.agent?.session?.header?.cwd
  let cwd
  if (modelWorkdir === undefined) cwd = headerCwd
  else if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) cwd = resolve(headerCwd, modelWorkdir)
  else cwd = modelWorkdir
  return cwd === undefined ? undefined : toWindowsPath(cwd, platform)
}

/** Convert a collected stream into plain text plus spill notice. */
function streamText(output) {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/** Render a settled subprocess result as model-facing text. */
export function renderResult(result) {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null && result.signal !== undefined) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * On Windows, hide `pwsh` and the legacy `gitbash` tool from the model so the
 * single existing `bash` tool is the only shell tool it can choose. Returns
 * the same array when nothing changes, preserving assembly identity.
 */
export function filterShellTools(tools) {
  if (!Array.isArray(tools)) return tools
  const filtered = tools.filter((tool) => tool?.name !== 'pwsh' && tool?.name !== LEGACY_GITBASH_TOOL_NAME)
  return filtered.length === tools.length ? tools : filtered
}

/** Resolve runtime configuration with validation. */
export function resolveConfig(config = {}, env = process.env, platform = process.platform, extra = []) {
  const source = config ?? {}
  const timeoutMs = source.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTimeoutMs = source.maxTimeoutMs ?? MAX_TIMEOUT_MS
  const maxOutputBytes = source.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const maxSpillBytes = source.maxSpillBytes ?? DEFAULT_MAX_SPILL_BYTES
  const graceMs = source.graceMs ?? DEFAULT_GRACE_MS
  for (const [label, value] of Object.entries({ timeoutMs, maxTimeoutMs, maxOutputBytes, maxSpillBytes, graceMs })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${TOOL_NAME}: ${label} must be a positive finite number`)
    }
  }
  if (timeoutMs > maxTimeoutMs) {
    throw new TypeError(`${TOOL_NAME}: timeoutMs must not exceed maxTimeoutMs`)
  }
  return {
    shellPath: detectGitBashPath(source.shellPath, env, platform, extra),
    timeoutMs,
    maxTimeoutMs,
    maxOutputBytes,
    maxSpillBytes,
    graceMs,
  }
}
