import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ConfirmedOpenRecorder,
  installConfirmedOpenHook,
  recordAfterSuccessfulOpen,
  tryInstallConfirmedOpenHook,
} from '../plugins/fuzzy-search/src/recent.ts'
import type { FrecencyStore } from '../plugins/fuzzy-search/src/frecency.ts'

const NOW = 1_000_000

test('concurrent transitions are serialized without dropping repeated paths', async () => {
  let store: FrecencyStore = {}
  const saves: string[] = []
  let releaseFirstSave!: () => void
  const firstSave = new Promise<void>(resolve => { releaseFirstSave = resolve })
  let saveCount = 0
  const recorder = new ConfirmedOpenRecorder({
    getStore: () => store,
    setStore: next => { store = next },
    save: async () => {
      saveCount += 1
      if (saveCount === 1) await firstSave
      saves.push(Object.keys(store).join(','))
    },
    now: () => NOW,
    maxEntries: 300,
  })

  const first = recorder.record('/a.md')
  const reopened = recorder.record('/a.md')
  const next = recorder.record('/b.md')
  releaseFirstSave()
  await Promise.all([first, reopened, next])

  assert.equal(store['/a.md']?.count, 2)
  assert.equal(store['/b.md']?.count, 1)
  assert.deepEqual(saves, ['/a.md', '/a.md', '/a.md,/b.md'])
})

test('a failed persistence retries the same draft without incrementing twice', async () => {
  let store: FrecencyStore = {}
  let attempts = 0
  const recorder = new ConfirmedOpenRecorder({
    getStore: () => store,
    setStore: next => { store = next },
    save: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('disk unavailable')
    },
    now: () => NOW,
    maxEntries: 300,
  })

  await assert.rejects(recorder.record('/a.md'), /disk unavailable/)
  await recorder.retryPending()

  assert.equal(attempts, 2)
  assert.equal(store['/a.md']?.count, 1)
})

test('a new transition replaces a failing pending snapshot without dropping either open', async () => {
  let store: FrecencyStore = {}
  let persisted: FrecencyStore = {}
  let failuresRemaining = 2
  const recorder = new ConfirmedOpenRecorder({
    getStore: () => store,
    setStore: next => { store = next },
    save: async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1
        throw new Error('disk unavailable')
      }
      persisted = structuredClone(store)
    },
    now: () => NOW,
    maxEntries: 300,
  })

  await assert.rejects(recorder.record('/a.md'), /disk unavailable/)
  await assert.rejects(recorder.record('/b.md'), /disk unavailable/)
  assert.equal(store['/a.md']?.count, 1, 'A remains accumulated in memory')
  assert.equal(store['/b.md']?.count, 1, 'B accumulates even while A snapshot cannot save')

  await recorder.retryPending()
  assert.equal(persisted['/a.md']?.count, 1)
  assert.equal(persisted['/b.md']?.count, 1)
})

test('confirmed-open hook preserves receiver/arguments, observes callback success, and restores exactly', () => {
  const calls: Array<{ receiver: unknown; path: string; flag: string }> = []
  const observed: string[] = []
  const library = {
    marker: 'library',
    openFile(this: unknown, path: string, callback: (status: string) => void, flag: string) {
      calls.push({ receiver: this, path, flag })
      callback.call({ callbackReceiver: true }, 'ok')
      return 42
    },
  }
  const original = library.openFile
  const hook = installConfirmedOpenHook(library, path => { observed.push(path) })
  let callbackThis: unknown
  let callbackStatus = ''

  const result = library.openFile('/manual.md', function (this: unknown, status: string) {
    callbackThis = this
    callbackStatus = status
  }, 'keep-me')

  assert.equal(result, 42)
  assert.deepEqual(calls, [{ receiver: library, path: '/manual.md', flag: 'keep-me' }])
  assert.deepEqual(callbackThis, { callbackReceiver: true })
  assert.equal(callbackStatus, 'ok')
  assert.deepEqual(observed, ['/manual.md'])
  hook.dispose()
  assert.equal(library.openFile, original)
})

test('confirmed-open hook does not observe throws or calls whose callback never fires', () => {
  const observed: string[] = []
  const library = {
    openFile(path: string, callback: () => void) {
      if (path === '/throw.md') throw new Error('open failed')
      void callback
    },
  }
  installConfirmedOpenHook(library, path => { observed.push(path) })

  assert.throws(() => library.openFile('/throw.md', () => {}), /open failed/)
  library.openFile('/timeout.md', () => {})
  assert.deepEqual(observed, [])
})

test('promise-returning opens confirm on resolve, reject silently, and never double-confirm callbacks', async () => {
  const observed: string[] = []
  const library = {
    openFile(path: string, callback?: () => void): Promise<string> {
      if (path === '/reject.md') return Promise.reject(new Error('host rejected'))
      callback?.()
      return Promise.resolve(path)
    },
  }
  const hook = installConfirmedOpenHook(library, path => { observed.push(path) })

  await library.openFile('/promise.md')
  await library.openFile('/callback-and-promise.md', () => {})
  await assert.rejects(library.openFile('/reject.md'), /host rejected/)

  assert.deepEqual(observed, ['/promise.md', '/callback-and-promise.md'])
  hook.dispose()
})

test('non-writable host openFile makes hook installation non-fatal', () => {
  const original = (path: string, callback: () => void) => { callback(); return path }
  const library = {} as { openFile: typeof original }
  Object.defineProperty(library, 'openFile', {
    value: original,
    writable: false,
    configurable: false,
  })
  const errors: unknown[] = []

  const hook = tryInstallConfirmedOpenHook(library, () => {}, error => { errors.push(error) })

  assert.equal(hook, null)
  assert.equal(library.openFile, original)
  assert.equal(errors.length, 1)
})

test('third-party wrapping does not retain disposed subscriptions across unload and reload', () => {
  const observed: string[] = []
  const library = {
    openFile(path: string, callback: () => void) { callback(); return path },
  }
  const first = installConfirmedOpenHook(library, path => { observed.push(`old:${path}`) })
  const dispatcher = library.openFile
  const thirdParty = function (this: unknown, ...args: Parameters<typeof dispatcher>) {
    return dispatcher.apply(this, args)
  }
  library.openFile = thirdParty

  assert.equal(first.isCurrent(), false)
  first.dispose()
  library.openFile('/after-unload.md', () => {})
  assert.equal(observed.length, 0, 'disposed subscriber is gone even though a third party retained the dispatcher')

  const second = installConfirmedOpenHook(library, path => { observed.push(`new:${path}`) })
  library.openFile('/after-reload.md', () => {})
  assert.deepEqual(observed, ['new:/after-reload.md'], 'nested stale dispatcher does not duplicate the new subscription')
  second.dispose()
  assert.equal(library.openFile, thirdParty, 'disposing preserves the third-party wrapper')
})

test('hook health detects host replacement and can safely rebind without overwriting it', () => {
  const observed: string[] = []
  const original = (path: string, callback: () => void) => { callback(); return path }
  const replacement = (path: string, callback: () => void) => { callback(); return `new:${path}` }
  const library = { openFile: original }
  const first = installConfirmedOpenHook(library, path => { observed.push(path) })
  assert.equal(first.isCurrent(), true)
  assert.equal(first.isCurrent({ openFile: replacement }), false, 'a replacement library object also requires rebinding')

  library.openFile = replacement
  assert.equal(first.isCurrent(), false)
  first.dispose()
  assert.equal(library.openFile, replacement)

  const rebound = installConfirmedOpenHook(library, path => { observed.push(path) })
  assert.equal(rebound.isCurrent(), true)
  library.openFile('/rebound.md', () => {})
  assert.deepEqual(observed, ['/rebound.md'])
  rebound.dispose()
})

test('two independent successful opens of the same path within 750ms both count', async () => {
  let store: FrecencyStore = {}
  let now = NOW
  const recorder = new ConfirmedOpenRecorder({
    getStore: () => store,
    setStore: next => { store = next },
    save: async () => {},
    now: () => now,
    maxEntries: 300,
  })

  await recordAfterSuccessfulOpen(async () => {}, () => recorder.record('/same.md'), false)
  now += 200
  await recordAfterSuccessfulOpen(async () => {}, () => recorder.record('/same.md'), false)
  assert.equal(store['/same.md']?.count, 2)
})

test('one Quick Open transition observed by a healthy hook counts only once', async () => {
  let store: FrecencyStore = {}
  const recorder = new ConfirmedOpenRecorder({
    getStore: () => store,
    setStore: next => { store = next },
    save: async () => {},
    now: () => NOW,
    maxEntries: 300,
  })
  const records: Promise<void>[] = []
  const library = {
    openFile(_path: string, callback: () => void) { callback() },
  }
  const hook = installConfirmedOpenHook(library, path => { records.push(recorder.record(path)) })
  const observedByHook = hook.isCurrent(library)

  await recordAfterSuccessfulOpen(
    () => new Promise<void>(resolve => { library.openFile('/same.md', resolve) }),
    () => recorder.record('/same.md'),
    observedByHook,
  )
  await Promise.all(records)

  assert.equal(store['/same.md']?.count, 1)
  hook.dispose()
})

test('Quick Open without a healthy hook records explicitly once after success', async () => {
  let store: FrecencyStore = {}
  const recorder = new ConfirmedOpenRecorder({
    getStore: () => store,
    setStore: next => { store = next },
    save: async () => {},
    now: () => NOW,
    maxEntries: 300,
  })

  await recordAfterSuccessfulOpen(
    async () => {},
    () => recorder.record('/explicit.md'),
    false,
  )
  assert.equal(store['/explicit.md']?.count, 1)
})

test('explicit Quick Open advances polling baseline before persistence so the next poll does not double-record', async () => {
  let store: FrecencyStore = {}
  let pollingBaseline = '/before.md'
  const recorder = new ConfirmedOpenRecorder({
    getStore: () => store,
    setStore: next => { store = next },
    save: async () => {},
    now: () => NOW,
    maxEntries: 300,
  })

  await recordAfterSuccessfulOpen(
    async () => {},
    () => recorder.record('/explicit.md'),
    false,
    () => { pollingBaseline = '/explicit.md' },
  )
  const activeFile = '/explicit.md'
  if (activeFile !== pollingBaseline) await recorder.record(activeFile)

  assert.equal(store['/explicit.md']?.count, 1)
})

test('rapid A to B to C transitions are all persisted', async () => {
  let store: FrecencyStore = {}
  let now = NOW
  const recorder = new ConfirmedOpenRecorder({
    getStore: () => store,
    setStore: next => { store = next },
    save: async () => {},
    now: () => now++,
    maxEntries: 300,
  })

  await Promise.all([recorder.record('/a.md'), recorder.record('/b.md'), recorder.record('/c.md')])
  assert.deepEqual(
    ['/a.md', '/b.md', '/c.md'].map(path => store[path]?.count),
    [1, 1, 1],
  )
})

test('Quick Open records only after the host open resolves and never records a failed open', async () => {
  const events: string[] = []
  await recordAfterSuccessfulOpen(
    async () => { events.push('opened') },
    async () => { events.push('recorded') },
  )
  assert.deepEqual(events, ['opened', 'recorded'])

  await assert.rejects(recordAfterSuccessfulOpen(
    async () => { throw new Error('host rejected') },
    async () => { events.push('must-not-record') },
  ), /host rejected/)
  assert.ok(!events.includes('must-not-record'))
})
