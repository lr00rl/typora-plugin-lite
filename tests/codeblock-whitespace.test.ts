import test from 'node:test'
import assert from 'node:assert/strict'

import {
  splitWhitespace,
  indentColumns,
  indentGuideColumns,
  indentGuideBackground,
  detectIndentUnit,
  guideColumnsPerLine,
  CODEBLOCK_MARKER_CSS,
} from '../packages/core/src/codeblock/whitespace.ts'

// --- splitWhitespace ---------------------------------------------------------

test('splitWhitespace groups maximal runs and preserves the text', () => {
  const chunks = splitWhitespace('  const x = 1\tend')
  assert.deepEqual(chunks, [
    { text: '  ', kind: 'space' },
    { text: 'const', kind: 'text' },
    { text: ' ', kind: 'space' },
    { text: 'x', kind: 'text' },
    { text: ' ', kind: 'space' },
    { text: '=', kind: 'text' },
    { text: ' ', kind: 'space' },
    { text: '1', kind: 'text' },
    { text: '\t', kind: 'tab' },
    { text: 'end', kind: 'text' },
  ])
  assert.equal(chunks.map(c => c.text).join(''), '  const x = 1\tend')
})

test('splitWhitespace handles edge cases', () => {
  assert.deepEqual(splitWhitespace(''), [])
  assert.deepEqual(splitWhitespace('   '), [{ text: '   ', kind: 'space' }])
  assert.deepEqual(splitWhitespace('\t\t'), [{ text: '\t\t', kind: 'tab' }])
  assert.deepEqual(splitWhitespace('abc'), [{ text: 'abc', kind: 'text' }])
})

// --- indentColumns -----------------------------------------------------------

test('indentColumns counts spaces and tab stops', () => {
  assert.equal(indentColumns('no indent', 4), 0)
  assert.equal(indentColumns('    four', 4), 4)
  assert.equal(indentColumns('\tone', 4), 4)
  assert.equal(indentColumns('\t\ttwo', 4), 8)
  assert.equal(indentColumns('  \tmixed', 4), 4) // two spaces, then tab jumps to the next stop
  assert.equal(indentColumns(' \todd', 4), 4)   // one space, tab advances 1→4
  assert.equal(indentColumns('     five', 4), 5)
})

// --- indentGuideColumns ------------------------------------------------------

test('indentGuideColumns emits every tab stop up to the indent', () => {
  assert.deepEqual(indentGuideColumns('flat', 4), [])
  assert.deepEqual(indentGuideColumns('  two', 4), [])       // below one tab stop
  assert.deepEqual(indentGuideColumns('    four', 4), [4])
  assert.deepEqual(indentGuideColumns('        eight', 4), [4, 8])
  assert.deepEqual(indentGuideColumns('\t\ttabs', 4), [4, 8])
})

// --- indentGuideBackground ---------------------------------------------------

test('indentGuideBackground paints 1px rules only at guide columns', () => {
  const bg = indentGuideBackground([4, 8], 'rgba(1,2,3,0.5)')!
  assert.ok(bg.image.startsWith('linear-gradient(90deg, '))
  // a rule at 4ch and 8ch, transparent elsewhere, sized to the last guide
  assert.ok(bg.image.includes('rgba(1,2,3,0.5) calc(4ch - 1px)'))
  assert.ok(bg.image.includes('rgba(1,2,3,0.5) 4ch'))
  assert.ok(bg.image.includes('rgba(1,2,3,0.5) calc(8ch - 1px)'))
  assert.equal(bg.size, '8ch 100%')
  // no rule at column 0: image starts transparent
  assert.ok(bg.image.includes('transparent 0ch'))
})

test('indentGuideBackground returns null when there are no guides', () => {
  assert.equal(indentGuideBackground([], 'red'), null)
})

// --- detectIndentUnit --------------------------------------------------------

test('detectIndentUnit finds 2-space and 4-space files', () => {
  const two = ['function a() {', '  if (x) {', '    y()', '  }', '}']
  assert.equal(detectIndentUnit(two, 4), 2)
  const four = ['def f():', '    if x:', '        y()', '    z()']
  assert.equal(detectIndentUnit(four, 4), 4)
})

test('detectIndentUnit: tabs mean tab-indented, whitespace-only lines are ignored', () => {
  assert.equal(detectIndentUnit(['a {', '\tx()', '\ty()', '}'], 4), 4)
  // a stray 1-space blank line must not poison the GCD
  assert.equal(detectIndentUnit(['a {', '  x()', ' ', '    y()', '}'], 4), 2)
  // one stray tab in a 2-space file must not flip the unit either
  assert.equal(detectIndentUnit(['a {', '  b {', '\tc()', '    d()', '  }', '}'], 4), 2)
  // no indentation at all → fall back to tabSize
  assert.equal(detectIndentUnit(['flat', 'file', 'here'], 4), 4)
  assert.equal(detectIndentUnit([], 4), 4)
})

// --- guideColumnsPerLine -----------------------------------------------------

test('guideColumnsPerLine steps by the detected unit', () => {
  const lines = ['a {', '  b {', '    c()', '  }', '}']
  assert.deepEqual(guideColumnsPerLine(lines, 4, 2), [
    [],
    [2],
    [2, 4],
    [2],
    [],
  ])
})

test('guideColumnsPerLine continues guides across blank lines (min of neighbors)', () => {
  const lines = ['a {', '  x()', '', '    y()', '}']
  // blank line between indent 2 and indent 4 → guides at min(2, 4) = 2
  assert.deepEqual(guideColumnsPerLine(lines, 4, 2)[2], [2])
})

test('guideColumnsPerLine: leading/trailing blanks and flat files get nothing', () => {
  assert.deepEqual(guideColumnsPerLine(['', 'x()'], 4, 2)[0], [])
  assert.deepEqual(guideColumnsPerLine(['x()', ''], 4, 2)[1], [])
  assert.deepEqual(guideColumnsPerLine(['flat', 'file'], 4, 4), [[], []])
})

// --- shared CSS fragment -----------------------------------------------------

test('the shared marker CSS uses the agreed class names and marker glyphs', () => {
  assert.ok(CODEBLOCK_MARKER_CSS.includes('.tpl-ws-sp'))
  assert.ok(CODEBLOCK_MARKER_CSS.includes('.tpl-ws-tab'))
  assert.ok(CODEBLOCK_MARKER_CSS.includes('»'))
  assert.ok(CODEBLOCK_MARKER_CSS.includes('--tpl-ws-color'))
})
