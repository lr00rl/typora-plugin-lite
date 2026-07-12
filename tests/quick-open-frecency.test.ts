import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FREQUENCY_CAP,
  frecencyScore,
  frecencySearchBoost,
  loadStore,
  pruneStore,
  rankByFrecency,
  recencyWeight,
  recordOpen,
  type FrecencyStore,
} from '../plugins/fuzzy-search/src/frecency.ts'

const NOW = 1_000_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

test('recency weight steps down over time and never rewards staleness over freshness', () => {
  assert.ok(recencyWeight(0) > recencyWeight(2 * HOUR))
  assert.ok(recencyWeight(2 * HOUR) > recencyWeight(2 * DAY))
  assert.ok(recencyWeight(2 * DAY) > recencyWeight(10 * DAY))
  assert.ok(recencyWeight(10 * DAY) > recencyWeight(100 * DAY))
})

test('clock skew (future timestamp) is treated as just-opened, not as ancient', () => {
  assert.equal(recencyWeight(-5000), 100)
})

test('a recently-opened file outranks an old one opened far more often', () => {
  const recent = { path: 'r', count: 1, lastOpenedAt: NOW - HOUR }
  const oldFavourite = { path: 'o', count: 40, lastOpenedAt: NOW - 60 * DAY }
  assert.ok(frecencyScore(recent, NOW) > frecencyScore(oldFavourite, NOW))
})

test('among equally-recent files, the more frequently opened wins', () => {
  const often = { path: 'a', count: 20, lastOpenedAt: NOW - HOUR }
  const seldom = { path: 'b', count: 1, lastOpenedAt: NOW - HOUR }
  assert.ok(frecencyScore(often, NOW) > frecencyScore(seldom, NOW))
})

test('frequency contribution is capped so one file cannot dominate forever', () => {
  const capped = { path: 'a', count: FREQUENCY_CAP, lastOpenedAt: NOW - HOUR }
  const beyond = { path: 'b', count: FREQUENCY_CAP + 1000, lastOpenedAt: NOW - HOUR }
  assert.equal(frecencyScore(capped, NOW), frecencyScore(beyond, NOW))
})

test('recordOpen increments count, updates recency, and does not mutate the input', () => {
  const store: FrecencyStore = {}
  const s1 = recordOpen(store, '/a.md', NOW - DAY)
  const s2 = recordOpen(s1, '/a.md', NOW)
  assert.equal(store['/a.md'], undefined, 'input store must be untouched')
  assert.equal(s2['/a.md']!.count, 2)
  assert.equal(s2['/a.md']!.lastOpenedAt, NOW)
})

test('rankByFrecency orders by score and honours the existence filter', () => {
  let store: FrecencyStore = {}
  store = recordOpen(store, '/keep.md', NOW)
  store = recordOpen(store, '/gone.md', NOW)
  store = recordOpen(store, '/old.md', NOW - 60 * DAY)

  const ranked = rankByFrecency(store, NOW, path => path !== '/gone.md')
  assert.deepEqual(ranked, ['/keep.md', '/old.md'], 'deleted file filtered out, recent first')
})

test('search boost is bounded and zero for unknown files', () => {
  let store: FrecencyStore = {}
  store = recordOpen(store, '/hot.md', NOW)
  const boost = frecencySearchBoost(store, '/hot.md', NOW)
  assert.ok(boost > 0)
  assert.ok(boost <= 40)
  assert.equal(frecencySearchBoost(store, '/never-opened.md', NOW), 0)
})

test('pruneStore keeps only the top-N most frecent entries', () => {
  let store: FrecencyStore = {}
  for (let i = 0; i < 10; i++) {
    store = recordOpen(store, `/f${i}.md`, NOW - i * DAY) // f0 most recent
  }
  const pruned = pruneStore(store, NOW, 3)
  assert.equal(Object.keys(pruned).length, 3)
  assert.ok(pruned['/f0.md'] && pruned['/f1.md'] && pruned['/f2.md'])
  assert.equal(pruned['/f9.md'], undefined)
})

test('loadStore migrates a legacy MRU array, preserving order as recency', () => {
  const store = loadStore(['/first.md', '/second.md', '/third.md'], NOW)
  const ranked = rankByFrecency(store, NOW)
  assert.deepEqual(ranked, ['/first.md', '/second.md', '/third.md'])
  assert.equal(store['/first.md']!.count, 1)
})

test('loadStore reads a persisted object and rejects malformed junk', () => {
  const store = loadStore(
    {
      '/good.md': { count: 3, lastOpenedAt: NOW },
      '/bad.md': { count: 'nope' },
      '/also-bad.md': null,
    },
    NOW,
  )
  assert.equal(store['/good.md']!.count, 3)
  assert.equal(store['/bad.md'], undefined)
  assert.equal(store['/also-bad.md'], undefined)
})

test('loadStore tolerates undefined/garbage input', () => {
  assert.deepEqual(loadStore(undefined, NOW), {})
  assert.deepEqual(loadStore(42, NOW), {})
})
