import test from 'node:test'
import assert from 'node:assert/strict'

import { PluginSettings } from '../packages/core/src/plugin/settings.ts'

/**
 * PluginSettings only touches disk via platform.fs; for unit coverage of
 * onChange semantics we stub a minimal Platform that ignores IO.
 */
function makeStubPlatform() {
  const noop = async () => {}
  return {
    path: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (p: string) => p.split('/').slice(0, -1).join('/') || '/',
      basename: (p: string) => p.split('/').pop() ?? '',
      extname: () => '',
      resolve: (...parts: string[]) => parts.join('/'),
      isAbsolute: (p: string) => p.startsWith('/'),
      sep: '/',
    },
    dataDir: '/tmp',
    legacyDataDirs: [],
    fs: {
      exists: async () => false,
      readText: async () => '',
      writeText: noop,
      mkdir: noop,
      appendText: noop,
      stat: async () => ({ size: 0, mtimeMs: 0, isDirectory: () => false, isFile: () => true }),
      remove: noop,
      list: async () => [],
      walk: async () => [],
    },
  } as any
}

interface TestShape extends Record<string, unknown> {
  count: number
  label: string
  enabled: boolean
}

function makeSettings(): PluginSettings<TestShape> {
  return new PluginSettings<TestShape>(
    'test-plugin',
    { count: 0, label: 'initial', enabled: false },
    makeStubPlatform(),
  )
}

test('onChange fires with key, new value, previous value', () => {
  const s = makeSettings()
  const events: Array<[string, unknown, unknown]> = []
  s.onChange((k, v, prev) => events.push([String(k), v, prev]))

  s.set('count', 42)
  s.set('label', 'updated')

  assert.deepEqual(events, [
    ['count', 42, 0],
    ['label', 'updated', 'initial'],
  ])
})

test('onChange does NOT fire when value is identical (Object.is)', () => {
  const s = makeSettings()
  let fired = 0
  s.onChange(() => { fired++ })

  s.set('count', 0)       // same as default
  s.set('label', 'initial') // same
  s.set('enabled', false)   // same
  assert.equal(fired, 0)

  s.set('count', 1)
  assert.equal(fired, 1)
})

test('onChange returns unsubscribe that stops further notifications', () => {
  const s = makeSettings()
  let fired = 0
  const unsubscribe = s.onChange(() => { fired++ })

  s.set('count', 1)
  assert.equal(fired, 1)

  unsubscribe()
  s.set('count', 2)
  s.set('count', 3)
  assert.equal(fired, 1, 'handler should not fire after unsubscribe')
})

test('multiple subscribers each receive every change independently', () => {
  const s = makeSettings()
  const a: string[] = []
  const b: string[] = []
  s.onChange((k) => { a.push(String(k)) })
  s.onChange((k) => { b.push(String(k)) })

  s.set('count', 1)
  s.set('label', 'x')

  assert.deepEqual(a, ['count', 'label'])
  assert.deepEqual(b, ['count', 'label'])
})

test('a thrown handler does not block other subscribers', () => {
  const s = makeSettings()
  const originalError = console.error
  console.error = () => {} // silence the expected log
  try {
    let reachedSecond = false
    s.onChange(() => { throw new Error('intentional') })
    s.onChange(() => { reachedSecond = true })

    s.set('count', 1)
    assert.equal(reachedSecond, true)
  } finally {
    console.error = originalError
  }
})

test('unsubscribing during dispatch is safe (snapshot iteration)', () => {
  const s = makeSettings()
  let firedA = 0
  let firedB = 0

  const unsubA = s.onChange(() => {
    firedA++
    unsubA() // remove self mid-dispatch
  })
  s.onChange(() => { firedB++ })

  s.set('count', 1)
  s.set('count', 2)

  // A only fires once (first call), B fires for both changes.
  assert.equal(firedA, 1)
  assert.equal(firedB, 2)
})
