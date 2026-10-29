import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { detectGitBashPath } from '../lib/gitbash-core.mjs'

/**
 * Run the real plugin against real Git Bash on Windows while adapting only the
 * DSH subprocess collector. This is not a full desktop Harness composition.
 */
function subprocessAdapter() {
  const spawned = []
  return {
    spawned,
    spawn(spec) {
      spawned.push(spec)
      const stdout = makeReader()
      const stderr = makeReader()
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        windowsHide: true,
        stdio: [spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      child.stdout.on('data', chunk => stdout.append(chunk))
      child.stderr.on('data', chunk => stderr.append(chunk))
      if (child.stdin !== null) child.stdin.end(spec.stdio.stdin.data)
      const abort = () => { child.kill() }
      if (spec.signal?.aborted) abort()
      else spec.signal?.addEventListener('abort', abort, { once: true })
      const done = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, signal) => {
          spec.signal?.removeEventListener('abort', abort)
          resolve({ exitCode, signal })
        })
      })
      return { collected: { stdout, stderr }, done, terminate: abort }
    },
  }
}

function makeReader() {
  const chunks = []
  return {
    append(chunk) { chunks.push(chunk) },
    readFrom(offset) {
      const buffer = Buffer.concat(chunks)
      return {
        text: buffer.subarray(offset).toString('utf8'),
        nextOffset: buffer.length,
        lossy: false,
      }
    },
  }
}

test('actual Windows plugin execute runs Git Bash script and returns managed output', {
  skip: process.platform !== 'win32',
}, async () => {
  const bash = detectGitBashPath(undefined, process.env, 'win32')
  assert.ok(bash, 'Windows Git Bash must be installed')
  const subprocess = subprocessAdapter()
  const ctx = {
    get(key) {
      if (key === 'subprocess') return subprocess
      if (key === 'sandboxPolicy') return { defaultMode: 'workspace-write' }
      return undefined
    },
    provide(key, value) { this[key] = value },
    logger: { warn() {} },
    on() {},
    tools: { guard() {} },
  }
  apply(ctx, { shellPath: bash })
  const request = {
    command: [
      'value=works',
      'printf "var:%s\\n" "$value"',
      'for item in a b; do printf "loop:%s\\n" "$item"; done',
      "cat <<'EOF'",
      'heredoc:$value',
      'EOF',
      'printf "msystem:%s\\n" "$MSYSTEM"',
    ].join('\n'),
    workdir: process.cwd(),
    sandboxPolicy: { mode: 'danger-full-access' },
    timeoutMs: 20000,
  }
  const exec = await ctx.shell.execute(ctx.shell.resolve(request))
  assert.equal(subprocess.spawned.length, 1)
  assert.deepEqual(subprocess.spawned[0].argv.slice(0, 2), [bash, '-lc'])
  const projected = exec.result()
  assert.strictEqual(exec.result(), projected)
  const result = await projected
  assert.equal(result.exitCode, 0, result.stderr.text)
  assert.match(result.stdout.text, /var:works/)
  assert.match(result.stdout.text, /loop:a/)
  assert.match(result.stdout.text, /loop:b/)
  assert.match(result.stdout.text, /heredoc:\$value/)
  assert.match(result.stdout.text, /msystem:(MINGW|MSYS)/)
  assert.equal(exec.status, 'completed')
  assert.equal(exec.observed.stdout.readFrom(0).text, result.stdout.text)
  assert.equal(exec.readOutput().delta, result.stdout.text)
  assert.equal(exec.readOutput().delta, '')

  const legacy = await ctx.shell.run(ctx.shell.resolve({
    ...request,
    command: 'printf "legacy:%s\\n" "$MSYSTEM"',
  }))
  assert.equal(legacy.exitCode, 0, legacy.stderr.text)
  assert.match(legacy.stdout.text, /legacy:(MINGW|MSYS)/)
  assert.equal(subprocess.spawned.length, 2)

  await assert.rejects(ctx.shell.execute(ctx.shell.resolve({
    ...request,
    sandboxPolicy: { mode: 'workspace-write' },
  })), /workspace-write/)
  assert.equal(subprocess.spawned.length, 2, 'denied command must not spawn')
})
