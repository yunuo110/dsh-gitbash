import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'

function reader() {
  let data = Buffer.alloc(0)
  return {
    append(text) { data = Buffer.concat([data, Buffer.from(text, 'utf8')]) },
    readFrom(offset) {
      return { text: data.subarray(offset).toString('utf8'), nextOffset: data.length, lossy: false }
    },
  }
}

function harness({ spawnThrows = false } = {}) {
  const spawned = []
  const subprocess = {
    spawn(spec) {
      if (spawnThrows) throw new Error('spawn blocked')
      let resolveDone
      let rejectDone
      const done = new Promise((resolve, reject) => {
        resolveDone = resolve
        rejectDone = reject
      })
      let settled = false
      const out = reader()
      const err = reader()
      const record = {
        spec,
        out,
        err,
        terminated: 0,
        finish(value = { exitCode: 0, signal: null }) {
          if (settled) return
          settled = true
          resolveDone(value)
        },
        reject(error) {
          if (settled) return
          settled = true
          rejectDone(error)
        },
      }
      spawned.push(record)
      const handle = {
        collected: { stdout: out, stderr: err },
        done,
        terminate() {
          record.terminated += 1
          record.finish({ exitCode: null, signal: 'SIGTERM' })
        },
      }
      if (spec.signal?.aborted) handle.terminate()
      else spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true })
      return handle
    },
  }
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
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    // Explicit shellPath avoids the registry and external process in unit tests.
    apply(ctx, { shellPath: 'D:\\Portable\\Git\\bin\\bash.exe' })
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
  return { shell: ctx.shell, spawned }
}

function spec(shell, overrides = {}) {
  return shell.resolve({
    command: 'echo test',
    workdir: 'D:\\workspace',
    sandboxPolicy: { mode: 'danger-full-access' },
    timeoutMs: 200,
    ...overrides,
  })
}

test('execute spawns eagerly, exposes a live handle and memoizes result()', async () => {
  const { shell, spawned } = harness()
  const execution = await shell.execute(spec(shell))
  assert.equal(spawned.length, 1)
  assert.equal(execution.status, 'running')
  assert.equal(typeof execution.kill, 'function')
  assert.equal(typeof execution.readOutput, 'function')
  assert.equal(typeof execution.observed.stdout.readFrom, 'function')
  spawned[0].out.append('one\n')
  assert.equal(execution.observed.stdout.readFrom(0).text, 'one\n')
  assert.equal(execution.readOutput().delta, 'one\n')
  assert.equal(execution.readOutput().delta, '')
  const resultPromise = execution.result()
  assert.strictEqual(execution.result(), resultPromise)
  spawned[0].err.append('notice\n')
  spawned[0].finish()
  await execution.done
  const result = await resultPromise
  assert.equal(execution.status, 'completed')
  assert.equal(execution.exitCode, 0)
  assert.equal(result.stdout.text, 'one\n')
  assert.equal(result.stderr.text, 'notice\n')
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
  assert.equal(execution.kill(), false)
  assert.equal(spawned.length, 1)
})

test('onExpiry none retains process beyond foreground timeoutMs', async () => {
  const { shell, spawned } = harness()
  const execution = await shell.execute(spec(shell, { timeoutMs: 15, onExpiry: 'none' }))
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.equal(execution.status, 'running')
  assert.equal(spawned[0].terminated, 0)
  spawned[0].finish()
  const result = await execution.result()
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
})

test('onExpiry kill terminates and reports first-cause timeout', async () => {
  const { shell, spawned } = harness()
  const execution = await shell.execute(spec(shell, { timeoutMs: 15, onExpiry: 'kill' }))
  const result = await execution.result()
  assert.equal(spawned[0].terminated, 1)
  assert.equal(execution.status, 'killed')
  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, false)
})

test('caller abort wins classification and disarms later timeout', async () => {
  const { shell, spawned } = harness()
  const controller = new AbortController()
  const execution = await shell.execute(spec(shell, { timeoutMs: 15, signal: controller.signal }))
  controller.abort(new Error('user cancelled'))
  const result = await execution.result()
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, true)
  assert.equal(spawned[0].terminated, 1)
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(result.timedOut, false)
})

test('run continues to return the historical result without duplicate spawn', async () => {
  const { shell, spawned } = harness()
  const promise = shell.run(spec(shell))
  assert.equal(spawned.length, 1)
  spawned[0].out.append('legacy\n')
  spawned[0].finish()
  const result = await promise
  assert.equal(result.stdout.text, 'legacy\n')
  assert.equal(spawned.length, 1)
})

test('start keeps historical background read and kill behavior', async () => {
  const { shell, spawned } = harness()
  const handle = shell.start(spec(shell))
  assert.equal(spawned.length, 1)
  spawned[0].out.append('bg\n')
  assert.equal(handle.readOutput().delta, 'bg\n')
  assert.equal(handle.kill(), true)
  await handle.done
  assert.equal(handle.status, 'killed')
  assert.equal(handle.kill(), false)
})

test('restricted modes reject before spawning for every interface', async () => {
  const { shell, spawned } = harness()
  const denied = spec(shell, { sandboxPolicy: { mode: 'workspace-write' } })
  await assert.rejects(shell.execute(denied), /workspace-write/)
  await assert.rejects(shell.run(denied), /workspace-write/)
  assert.throws(() => shell.start(denied), /workspace-write/)
  await assert.rejects(shell.execute(spec(shell, { sandboxPolicy: {} })), /unknown/)
  assert.equal(spawned.length, 0)
})

test('sync spawn failure settles done, reports stderr and rejects result', async () => {
  const { shell } = harness({ spawnThrows: true })
  const execution = await shell.execute(spec(shell))
  await execution.done
  assert.equal(execution.status, 'killed')
  assert.match(execution.observed.stderr.readFrom(0).text, /spawn blocked/)
  assert.match(execution.readOutput().delta, /spawn blocked/)
  assert.equal(execution.readOutput().delta, '')
  await assert.rejects(execution.result(), /spawn blocked/)
})

test('provider rejection retains the same failure semantics', async () => {
  const { shell, spawned } = harness()
  const execution = await shell.execute(spec(shell))
  spawned[0].reject(new Error('provider failed'))
  await execution.done
  assert.equal(execution.status, 'killed')
  await assert.rejects(execution.result(), /provider failed/)
})
