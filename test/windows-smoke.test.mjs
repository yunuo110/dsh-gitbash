import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { detectGitBashPath } from '../lib/gitbash-core.mjs'

test('Windows Git for Windows runs variables, loops and heredocs without WSL', {
  skip: process.platform !== 'win32',
}, () => {
  const bash = detectGitBashPath(undefined, process.env, 'win32')
  assert.ok(bash, 'Git for Windows must be discoverable on windows-latest')
  const command = [
    'value=YES',
    'printf "var:%s\\n" "$value"',
    'for item in a b; do printf "loop:%s\\n" "$item"; done',
    "cat <<'EOF'",
    'heredoc:$value',
    'EOF',
    'uname',
  ].join('\n')
  const result = spawnSync(bash, ['-lc', command], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr || String(result.error))
  assert.match(result.stdout, /var:YES/)
  assert.match(result.stdout, /loop:a/)
  assert.match(result.stdout, /loop:b/)
  assert.match(result.stdout, /heredoc:\$value/)
  assert.match(result.stdout, /(MINGW|MSYS)/)
})
