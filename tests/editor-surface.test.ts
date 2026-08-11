import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canFitEditorReserve,
  measureVisibleEditorHostWidth,
  observeEditorHostResize,
} from '../packages/core/src/ui/editor-surface.ts'

test('measures the writing host instead of the outer window', () => {
  const host = {
    getBoundingClientRect: () => ({ left: 280, right: 1000, width: 720 }),
    clientWidth: 720,
  }
  const write = { parentElement: host }

  assert.equal(measureVisibleEditorHostWidth(write as unknown as HTMLElement), 720)
})

test('uses the smaller host width when clientWidth excludes a scrollbar', () => {
  const host = {
    getBoundingClientRect: () => ({ width: 720 }),
    clientWidth: 704,
  }
  const write = { parentElement: host }

  assert.equal(measureVisibleEditorHostWidth(write as unknown as HTMLElement), 704)
})

test('requires prose plus exactly one reserve inside the host shell', () => {
  assert.equal(canFitEditorReserve(1260, 300, 860), true)
  assert.equal(canFitEditorReserve(1259, 300, 860), false)
})

test('observes the host so sidebar resizing can recompute editor geometry', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  const host = {
    getBoundingClientRect: () => ({ width: 720 }),
    clientWidth: 720,
  }
  const write = { parentElement: host }
  let observed: unknown = null
  let disconnected = false
  let callbackCalls = 0

  class FakeResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe(target: unknown) {
      observed = target
      this.callback()
    }
    disconnect() {
      disconnected = true
    }
  }

  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: FakeResizeObserver,
    configurable: true,
  })
  try {
    const stop = observeEditorHostResize(
      write as unknown as HTMLElement,
      () => { callbackCalls += 1 },
    )
    assert.equal(observed, host)
    assert.equal(callbackCalls, 1)
    stop()
    assert.equal(disconnected, true)
  } finally {
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original)
    else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  }
})
