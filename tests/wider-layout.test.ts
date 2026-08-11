import test from 'node:test'
import assert from 'node:assert/strict'

import { calculateWiderLayout } from '../plugins/wider/src/layout.ts'

test('keeps a focused 860px reading column on both laptop and desktop viewports', () => {
  assert.deepEqual(
    calculateWiderLayout({ mode: 'default', hostWidth: 1512, sidenoteReserve: 0 }),
    { shellGutter: 60, contentWidth: 860, maxWidth: 860 },
  )
  assert.deepEqual(
    calculateWiderLayout({ mode: 'default', hostWidth: 2560, sidenoteReserve: 0 }),
    { shellGutter: 72, contentWidth: 860, maxWidth: 860 },
  )
})

test('uses a responsive technical-document width for wide mode', () => {
  assert.deepEqual(
    calculateWiderLayout({ mode: 'wide', hostWidth: 1512, sidenoteReserve: 0 }),
    { shellGutter: 60, contentWidth: 1086, maxWidth: 1086 },
  )
  assert.deepEqual(
    calculateWiderLayout({ mode: 'wide', hostWidth: 2560, sidenoteReserve: 0 }),
    { shellGutter: 72, contentWidth: 1180, maxWidth: 1180 },
  )
})

test('fills available laptop space but caps full mode on a large desktop', () => {
  assert.deepEqual(
    calculateWiderLayout({ mode: 'full', hostWidth: 1512, sidenoteReserve: 0 }),
    { shellGutter: 60, contentWidth: 1392, maxWidth: 1392 },
  )
  assert.deepEqual(
    calculateWiderLayout({ mode: 'full', hostWidth: 2560, sidenoteReserve: 0 }),
    { shellGutter: 72, contentWidth: 1680, maxWidth: 1680 },
  )
})

test('collapses modes safely when a small window cannot fit the requested width', () => {
  assert.deepEqual(
    calculateWiderLayout({ mode: 'default', hostWidth: 900, sidenoteReserve: 0 }),
    { shellGutter: 16, contentWidth: 860, maxWidth: 860 },
  )
  assert.deepEqual(
    calculateWiderLayout({ mode: 'wide', hostWidth: 900, sidenoteReserve: 0 }),
    { shellGutter: 16, contentWidth: 868, maxWidth: 868 },
  )
  assert.deepEqual(
    calculateWiderLayout({ mode: 'full', hostWidth: 900, sidenoteReserve: 0 }),
    { shellGutter: 16, contentWidth: 868, maxWidth: 868 },
  )
})

test('reserves the sidenote gutter without inflating the prose width', () => {
  assert.deepEqual(
    calculateWiderLayout({ mode: 'default', hostWidth: 1512, sidenoteReserve: 300 }),
    { shellGutter: 60, contentWidth: 860, maxWidth: 1160 },
  )
  assert.deepEqual(
    calculateWiderLayout({ mode: 'wide', hostWidth: 1512, sidenoteReserve: 300 }),
    { shellGutter: 60, contentWidth: 1000, maxWidth: 1300 },
  )
  assert.deepEqual(
    calculateWiderLayout({ mode: 'full', hostWidth: 1512, sidenoteReserve: 300 }),
    { shellGutter: 60, contentWidth: 1092, maxWidth: 1392 },
  )
})

test('never forces the 560px floor beyond the actual viewport', () => {
  for (const mode of ['default', 'wide', 'full'] as const) {
    assert.deepEqual(
      calculateWiderLayout({ mode, hostWidth: 480, sidenoteReserve: 0 }),
      { shellGutter: 16, contentWidth: 448, maxWidth: 448 },
    )
  }
})

test('clamps every mode to the visible editor host when a sidebar reduces it', () => {
  for (const mode of ['default', 'wide', 'full'] as const) {
    const layout = calculateWiderLayout({ mode, hostWidth: 720, sidenoteReserve: 0 })
    assert.ok(layout.maxWidth <= 720 - (layout.shellGutter * 2))
  }
})

test('drops the sidenote reserve when it would not fit in the editor host', () => {
  assert.deepEqual(
    calculateWiderLayout({ mode: 'full', hostWidth: 1100, sidenoteReserve: 300 }),
    { shellGutter: 44, contentWidth: 1012, maxWidth: 1012 },
  )
})
