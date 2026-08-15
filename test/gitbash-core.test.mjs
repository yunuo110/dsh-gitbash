import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BASH_TOOL_DESCRIPTION,
  buildArgv,
  buildEnv,
  candidateGitBashPaths,
  clampTimeout,
  detectGitBashPath,
  filterShellTools,
  LEGACY_GITBASH_TOOL_NAME,
  renderResult,
  resolveConfig,
  resolveWorkdir,
  toWindowsPath,
  TOOL_NAME,
  validateArgs,
} from '../lib/gitbash-core.mjs'

test('exports the single bash tool name', () => {
  assert.equal(TOOL_NAME, 'bash')
  assert.equal(LEGACY_GITBASH_TOOL_NAME, 'gitbash')
})

test('description mentions Git Bash and POSIX syntax', () => {
  assert.match(BASH_TOOL_DESCRIPTION, /Git Bash/)
  assert.match(BASH_TOOL_DESCRIPTION, /POSIX\/bash syntax/)
  assert.match(BASH_TOOL_DESCRIPTION, /fresh non-interactive/)
})

test('candidateGitBashPaths prefers GIT_BASH and excludes System32 WSL bash', () => {
  const candidates = candidateGitBashPaths({
    GIT_BASH: 'D:\\git\\bash.exe',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    PATH: 'C:\\Windows\\System32;C:\\Tools',
  })
  assert.equal(candidates[0], 'D:\\git\\bash.exe')
  assert.ok(candidates.includes('C:\\Program Files\\Git\\bin\\bash.exe'))
  assert.ok(candidates.includes('C:\\Program Files (x86)\\Git\\bin\\bash.exe'))
  assert.ok(candidates.includes('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'))
  assert.ok(candidates.includes('C:\\Tools\\bash.exe'))
  assert.ok(!candidates.some((candidate) => candidate.toLowerCase().includes('system32')))
})

test('detectGitBashPath prefers explicit path on Windows', () => {
  assert.equal(
    detectGitBashPath('C:\\Program Files\\Git\\bin\\bash.exe', {}, 'win32'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  )
})

test('detectGitBashPath returns undefined on POSIX hosts', () => {
  assert.equal(detectGitBashPath(undefined, {}, 'linux'), undefined)
})

test('buildArgv uses login bash and passes the command', () => {
  assert.deepEqual(
    buildArgv('C:\\Git\\bin\\bash.exe', 'git status'),
    ['C:\\Git\\bin\\bash.exe', '-lc', 'git status'],
  )
})

test('buildEnv keeps plain-output overrides and merges DSH env', () => {
  const env = buildEnv({ DSH_WEB_URL: 'http://127.0.0.1:3080' })
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.TERM, 'dumb')
  assert.equal(env.GIT_PAGER, 'cat')
  assert.equal(env.PYTHONUTF8, '1')
  assert.equal(env.PYTHONIOENCODING, 'utf-8')
  assert.equal(env.LC_ALL, 'C.UTF-8')
  assert.equal(env.DSH_WEB_URL, 'http://127.0.0.1:3080')
})

test('validateArgs rejects empty commands and paired escalation args', () => {
  assert.throws(() => validateArgs({ command: '', description: 'x' }), /command/)
  assert.throws(() => validateArgs({ command: 'ls', description: '' }), /description/)
  assert.throws(() => validateArgs({ command: 'ls', description: 'x', sandbox_permissions: 'danger-full-access' }), /together/)
  assert.doesNotThrow(() => validateArgs({ command: 'ls', description: 'x' }))
})

test('filterShellTools removes pwsh and legacy gitbash but keeps bash', () => {
  const tools = [
    { name: 'pwsh' },
    { name: 'bash' },
    { name: 'gitbash' },
    { name: 'read' },
  ]
  const filtered = filterShellTools(tools)
  assert.deepEqual(filtered.map((tool) => tool.name), ['bash', 'read'])
  assert.notEqual(filtered, tools)
  const readOnly = [{ name: 'read' }]
  assert.equal(filterShellTools(readOnly), readOnly)
})

test('clampTimeout bounds caller timeouts', () => {
  assert.equal(clampTimeout(undefined), 120000)
  assert.equal(clampTimeout(5000), 5000)
  assert.equal(clampTimeout(999999999), 600000)
  assert.throws(() => clampTimeout(-1), /timeoutMs/)
})

test('toWindowsPath converts MSYS drive paths', () => {
  assert.equal(toWindowsPath('/d/foo', 'win32'), 'D:\\foo')
  assert.equal(toWindowsPath('/c', 'win32'), 'C:\\')
  assert.equal(toWindowsPath('/usr/bin', 'win32'), '/usr/bin')
})

test('resolveWorkdir uses header cwd for relative workdirs', () => {
  const exec = { agent: { session: { header: { cwd: 'F:\\code' } } } }
  assert.equal(resolveWorkdir(undefined, exec), 'F:\\code')
  assert.equal(resolveWorkdir('project', exec), 'F:\\code\\project')
  assert.equal(resolveWorkdir('D:\\absolute', exec), 'D:\\absolute')
  assert.equal(resolveWorkdir('/d/foo', exec, 'win32'), 'D:\\foo')
})

test('renderResult formats stdout, stderr, and exit markers', () => {
  const result = {
    exitCode: 1,
    signal: null,
    timedOut: false,
    timeoutMs: 120000,
    stdout: { text: 'out', truncated: false },
    stderr: { text: 'err', truncated: false },
  }
  assert.match(renderResult(result), /out/)
  assert.match(renderResult(result), /\[stderr\]/)
  assert.match(renderResult(result), /\[exit code: 1\]/)
})

test('resolveConfig validates numbers and detects explicit shellPath', () => {
  const config = resolveConfig({ shellPath: 'C:\\Git\\bin\\bash.exe', timeoutMs: 1000 }, {}, 'win32')
  assert.equal(config.shellPath, 'C:\\Git\\bin\\bash.exe')
  assert.equal(config.timeoutMs, 1000)
  assert.throws(() => resolveConfig({ timeoutMs: 0 }, {}, 'win32'), /timeoutMs/)
  assert.throws(() => resolveConfig({ timeoutMs: 200000, maxTimeoutMs: 100000 }, {}, 'win32'), /must not exceed/)
})
