import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

import {
  MAX_DIGITS,
  MIN_DIGITS,
  applyGutterDigits,
  countFenceLines,
  digitsForLineCount,
} from '../plugins/fence-enhance/src/gutter.ts'

// --- digitsForLineCount ------------------------------------------------------

test('a short snippet reserves the two-digit minimum, not a fixed wide gutter', () => {
  assert.equal(digitsForLineCount(1), MIN_DIGITS)
  assert.equal(digitsForLineCount(7), MIN_DIGITS)
  assert.equal(digitsForLineCount(99), 2)
})

test('gutter grows exactly one column per decade', () => {
  assert.equal(digitsForLineCount(100), 3)
  assert.equal(digitsForLineCount(999), 3)
  assert.equal(digitsForLineCount(1000), 4)
  assert.equal(digitsForLineCount(1200), 4)
  assert.equal(digitsForLineCount(12345), 5)
})

test('gutter clamps rather than growing without bound on absurd input', () => {
  assert.equal(digitsForLineCount(10_000_000), MAX_DIGITS)
})

test('nonsense line counts fall back to the minimum instead of producing NaN width', () => {
  assert.equal(digitsForLineCount(0), MIN_DIGITS)
  assert.equal(digitsForLineCount(-5), MIN_DIGITS)
  assert.equal(digitsForLineCount(Number.NaN), MIN_DIGITS)
  assert.equal(digitsForLineCount(Number.POSITIVE_INFINITY), MIN_DIGITS)
})

// --- countFenceLines ---------------------------------------------------------

function withDom(html: string): { fence: any; cleanup: () => void } {
  const window = new Window()
  const document = window.document
  document.body.innerHTML = html
  const fence = document.querySelector('.md-fences')
  return { fence, cleanup: () => window.close() }
}

test('counts lines from the live CodeMirror instance when the block is initialized', () => {
  const { fence, cleanup } = withDom('<div class="md-fences"></div>')
  assert.equal(countFenceLines(fence, { lineCount: () => 42 }), 42)
  cleanup()
})

test('counts rendered row divs when CodeMirror exists but no instance was passed', () => {
  // An initialized fence keeps each line in its own div, so textContent has no
  // newlines at all — counting "\n" here would wrongly report a single line.
  const { fence, cleanup } = withDom(`
    <div class="md-fences">
      <div class="CodeMirror-code">
        <div><pre class="CodeMirror-line">a</pre></div>
        <div><pre class="CodeMirror-line">b</pre></div>
        <div><pre class="CodeMirror-line">c</pre></div>
      </div>
    </div>
  `)
  assert.equal(countFenceLines(fence, null), 3)
  cleanup()
})

test('counts newlines in the raw source when the block has not been initialized yet', () => {
  // This is the state Typora leaves every fence past the 8th in: no CodeMirror,
  // just the source sitting in the element.
  const { fence, cleanup } = withDom('<div class="md-fences">one\ntwo\nthree</div>')
  assert.equal(countFenceLines(fence, null), 3)
  cleanup()
})

test('a trailing newline does not inflate the count into an extra digit', () => {
  // 9 lines + trailing newline must stay 1 digit worth of content, not tip to 10.
  const { fence, cleanup } = withDom(
    `<div class="md-fences">${Array.from({ length: 9 }, (_, i) => `line${i}`).join('\n')}\n</div>`,
  )
  assert.equal(countFenceLines(fence, null), 9)
  cleanup()
})

test('the injected copy button is not counted as a line of code', () => {
  const { fence, cleanup } = withDom(
    '<div class="md-fences">one\ntwo<button class="tpl-fence-copy">Copy</button></div>',
  )
  assert.equal(countFenceLines(fence, null), 2)
  cleanup()
})

test('an empty fence is one line, never zero', () => {
  const { fence, cleanup } = withDom('<div class="md-fences"></div>')
  assert.equal(countFenceLines(fence, null), 1)
  cleanup()
})

test('a CodeMirror that throws falls back to the DOM instead of breaking the gutter', () => {
  const { fence, cleanup } = withDom('<div class="md-fences">a\nb</div>')
  const hostile = { lineCount: () => { throw new Error('detached') } }
  assert.equal(countFenceLines(fence, hostile), 2)
  cleanup()
})

// --- applyGutterDigits -------------------------------------------------------

test('writes the digit count as a custom property on the block itself', () => {
  const { fence, cleanup } = withDom('<div class="md-fences"></div>')
  assert.equal(applyGutterDigits(fence, 3), true)
  assert.equal(fence.style.getPropertyValue('--tpl-lineno-digits'), '3')
  cleanup()
})

test('re-applying the same width reports no change, so hot edit paths can skip the write', () => {
  const { fence, cleanup } = withDom('<div class="md-fences"></div>')
  assert.equal(applyGutterDigits(fence, 3), true)
  assert.equal(applyGutterDigits(fence, 3), false)
  assert.equal(applyGutterDigits(fence, 4), true)
  cleanup()
})
