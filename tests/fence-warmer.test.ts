import test from 'node:test'
import assert from 'node:assert/strict'

import { FenceWarmer, type WarmerHost } from '../plugins/fence-enhance/src/warmer.ts'

/**
 * Drives the warmer with a manual scheduler so each idle slice can be stepped
 * deterministically. `flush()` runs slices until the warmer stops asking for
 * more (bounded, so a scheduling bug fails the test instead of hanging it).
 */
function harness(options: {
  fenceCount: number
  ready?: boolean
  chunkSize?: number
  maxFences?: number
}) {
  const fences = Array.from({ length: options.fenceCount }, (_, i) => ({
    id: i,
    isConnected: true,
    live: false,
  }))

  const warmedOrder: number[] = []
  let queued: (() => void) | null = null
  let cancelled = 0
  let ready = options.ready ?? true

  const host: WarmerHost = {
    collect: () => fences.filter(f => f.isConnected) as unknown as Element[],
    warm: (fence: any) => {
      if (fence.live) return false
      fence.live = true
      warmedOrder.push(fence.id)
      return true
    },
    ready: () => ready,
  }

  const warmer = new FenceWarmer(host, {
    chunkSize: options.chunkSize ?? 3,
    maxFences: options.maxFences,
    schedule: cb => { queued = cb; return 1 },
    // Deliberately does NOT drop the queued callback. A real cancelIdleCallback
    // cannot un-fire a slice that has already begun executing, so the warmer's
    // generation check — not the cancel — has to be what keeps a stale slice
    // from touching a document that is no longer on screen. Leaving the callback
    // in place is what puts that guard under test.
    cancel: () => { cancelled++ },
  })

  return {
    fences,
    warmedOrder,
    warmer,
    setReady: (v: boolean) => { ready = v },
    cancelCount: () => cancelled,
    step(): boolean {
      const cb = queued
      queued = null
      if (!cb) return false
      cb()
      return true
    },
    flush(maxSlices = 100): void {
      for (let i = 0; i < maxSlices; i++) {
        const cb = queued
        queued = null
        if (!cb) return
        cb()
      }
      throw new Error('warmer never finished — scheduling loop?')
    },
  }
}

test('warms every block in the document, not just the eight Typora bothers with', () => {
  const h = harness({ fenceCount: 20 })
  h.warmer.restart()
  h.flush()
  assert.equal(h.warmedOrder.length, 20)
  assert.equal(h.fences.every(f => f.live), true)
})

test('warms strictly top to bottom, so height changes land below the viewport', () => {
  // Order is the whole safety argument: initializing a block *above* the reader
  // grows it and yanks the scroll position. Going top-down means every block the
  // reader has passed was already warm.
  const h = harness({ fenceCount: 12 })
  h.warmer.restart()
  h.flush()
  assert.deepEqual(h.warmedOrder, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})

test('yields between slices instead of initializing the whole document in one frame', () => {
  const h = harness({ fenceCount: 9, chunkSize: 3 })
  h.warmer.restart()
  assert.deepEqual(h.warmedOrder, [], 'restart must not warm synchronously')

  h.step()
  assert.deepEqual(h.warmedOrder, [0, 1, 2])
  h.step()
  assert.deepEqual(h.warmedOrder, [0, 1, 2, 3, 4, 5])
  h.step()
  assert.deepEqual(h.warmedOrder, [0, 1, 2, 3, 4, 5, 6, 7, 8])
})

test('waits for CodeMirror modes before warming, so blocks never come up uncoloured', () => {
  const h = harness({ fenceCount: 5, ready: false })
  h.warmer.restart()
  h.step()
  h.step()
  assert.deepEqual(h.warmedOrder, [], 'must not warm while modes are still loading')

  h.setReady(true)
  h.flush()
  assert.equal(h.warmedOrder.length, 5)
})

test('switching files mid-warm abandons the old pass instead of touching stale blocks', () => {
  const h = harness({ fenceCount: 30, chunkSize: 3 })
  h.warmer.restart()
  h.step()
  assert.deepEqual(h.warmedOrder, [0, 1, 2])

  // User opens another document. The queued slice still holds the old element
  // list; it must notice its generation is stale and drop.
  h.warmer.stop()
  const beforeStop = h.warmedOrder.length
  h.step()
  assert.equal(h.warmedOrder.length, beforeStop, 'stale slice must not warm anything')
})

test('restart cancels the in-flight pass rather than running two at once', () => {
  const h = harness({ fenceCount: 30, chunkSize: 3 })
  h.warmer.restart()
  h.step()
  h.warmer.restart()
  h.flush()

  // Already-live blocks are skipped, so nothing gets warmed twice — which would
  // leak the first CodeMirror instance.
  const unique = new Set(h.warmedOrder)
  assert.equal(unique.size, h.warmedOrder.length, 'a block was initialized twice')
  assert.equal(h.warmedOrder.length, 30)
})

test('blocks already warmed by the viewport observer do not consume a slice budget', () => {
  const h = harness({ fenceCount: 6, chunkSize: 2 })
  // Pretend the observer got to these first while the user scrolled.
  h.fences[0]!.live = true
  h.fences[1]!.live = true

  h.warmer.restart()
  h.step()
  // Budget is 2 *initializations*, and 0/1 cost nothing, so this slice should
  // still manage to bring two fresh blocks up.
  assert.deepEqual(h.warmedOrder, [2, 3])
})

test('blocks deleted mid-pass are skipped instead of throwing', () => {
  const h = harness({ fenceCount: 6, chunkSize: 10 })
  h.warmer.restart()
  h.fences[2]!.isConnected = false
  h.fences[3]!.isConnected = false
  h.flush()
  assert.deepEqual(h.warmedOrder, [0, 1, 4, 5])
})

test('pathologically large documents are left to the viewport observer', () => {
  const h = harness({ fenceCount: 50, maxFences: 10 })
  h.warmer.restart()
  h.flush()
  assert.deepEqual(h.warmedOrder, [], 'should decline to eagerly warm a huge document')
})

test('an empty document schedules no work at all', () => {
  const h = harness({ fenceCount: 0 })
  h.warmer.restart()
  assert.equal(h.step(), false)
})
