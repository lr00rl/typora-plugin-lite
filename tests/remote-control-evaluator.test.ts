import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createScriptRunner,
  evaluateInRenderer,
  toSerializable,
} from '../plugins/remote-control/src/typora/evaluator.ts'

// --- createScriptRunner: the macOS bug this whole module exists to fix -------

test('falls back to indirect eval when window.reqnode is undefined (macOS WKWebView)', async () => {
  // This is the exact condition that made typora.eval throw on every macOS
  // call: reqnode is undefined, so the old `window.reqnode("vm")` blew up.
  const run = createScriptRunner(undefined)
  const out = await evaluateInRenderer({ code: 'return 1 + 2' }, { run })
  assert.deepEqual(out, { result: 3, async: false })
})

test('uses vm.runInThisContext when reqnode provides it (Electron)', async () => {
  const calls: string[] = []
  const fakeReqnode = (mod: string) => {
    calls.push(mod)
    if (mod !== 'vm') throw new Error(`unexpected require: ${mod}`)
    return { runInThisContext: (script: string) => (0, eval)(script) }
  }
  const run = createScriptRunner(fakeReqnode)
  const out = await evaluateInRenderer({ code: 'return 40 + 2' }, { run })
  assert.deepEqual(out, { result: 42, async: false })
  assert.deepEqual(calls, ['vm'])
})

test('falls back to indirect eval if requiring vm throws', async () => {
  const run = createScriptRunner(() => { throw new Error('no native module') })
  const out = await evaluateInRenderer({ code: 'return "ok"' }, { run })
  assert.equal(out.result, 'ok')
})

// --- evaluateInRenderer: sync + async --------------------------------------

test('runs sync code and returns its completion value', async () => {
  const run = createScriptRunner(undefined)
  const out = await evaluateInRenderer({ code: 'const x = 21; return x * 2' }, { run })
  assert.equal(out.result, 42)
  assert.equal(out.async, false)
})

test('awaits async code and marks the result async', async () => {
  const run = createScriptRunner(undefined)
  const out = await evaluateInRenderer(
    { code: 'await Promise.resolve(); return "done"', async: true },
    { run },
  )
  assert.equal(out.result, 'done')
  assert.equal(out.async, true)
})

test('a thrown error propagates instead of being swallowed', async () => {
  const run = createScriptRunner(undefined)
  await assert.rejects(
    evaluateInRenderer({ code: 'throw new Error("boom")' }, { run }),
    /boom/,
  )
})

test('async code that never settles is rejected by the wall-clock timeout', async () => {
  const run = createScriptRunner(undefined)
  // A never-resolving promise stands in for a hung await. The injected timer
  // fires deterministically so the test does not actually wait.
  let fire: () => void = () => {}
  const out = evaluateInRenderer(
    { code: 'await new Promise(() => {}); return 1', async: true, timeoutMs: 5000 },
    {
      run,
      setTimer: cb => { fire = cb as () => void; return 1 },
      clearTimer: () => {},
    },
  )
  fire()
  await assert.rejects(out, /timed out after 5000ms/)
})

test('async timeout is cleared when the promise settles first', async () => {
  const run = createScriptRunner(undefined)
  let cleared = false
  const out = await evaluateInRenderer(
    { code: 'return await Promise.resolve(7)', async: true, timeoutMs: 5000 },
    {
      run,
      setTimer: () => 1,
      clearTimer: () => { cleared = true },
    },
  )
  assert.equal(out.result, 7)
  assert.equal(cleared, true, 'a settled promise must clear its timeout timer')
})

// --- toSerializable ---------------------------------------------------------

test('coerces values that would not survive JSON.stringify', () => {
  assert.equal(toSerializable(undefined), null)
  assert.equal(toSerializable(null), null)
  assert.equal(toSerializable(10n), '10')
  assert.equal(toSerializable(() => {}), '<function>')
  assert.equal(toSerializable(Symbol('s')), '<symbol>')
  assert.deepEqual(toSerializable({ a: 1, b: [2, 3] }), { a: 1, b: [2, 3] })
})

test('a circular structure degrades to a string tag instead of throwing', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  // Must not throw; the exact fallback string is unimportant.
  assert.doesNotThrow(() => toSerializable(circular))
})
