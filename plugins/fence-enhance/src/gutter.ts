/**
 * Adaptive line-number gutter sizing.
 *
 * The gutter used to be one fixed width for every code block in the document:
 *
 *     .md-fences-with-lineno { --code-line-number-gutter-width: 4.75em; }
 *
 * 4.75em is roughly five digits' worth of space, so it is simultaneously
 * *too wide* (a 6-line snippet — by far the common case — wastes ~4 characters
 * of indent on every line) and *too narrow* (a 10k-line paste overflows it).
 * The width has to be a property of the individual block, not the theme.
 *
 * So each fence gets its own `--tpl-lineno-digits`, and the width is derived:
 *
 *     --code-line-number-gutter-width:
 *         calc(var(--tpl-lineno-digits) * 1ch + var(--tpl-lineno-padding))
 *
 * `1ch` is the advance width of "0", which in the monospace face used for code
 * is exactly one digit — so N digits reserve exactly N digits of space, and a
 * 9-line block is visibly tighter than a 1200-line one.
 */

/**
 * Never go below two digits. A one-digit gutter reads as cramped next to the
 * border, and blocks in the 1–9 line range are exactly the ones that grow into
 * double digits as you type — reserving the second column up front avoids a
 * reflow on the 10th line.
 */
export const MIN_DIGITS = 2

/**
 * Above 6 digits (999,999 lines) we stop widening. Nothing sane is that long,
 * and an unbounded gutter is a nicer bug to have as a clamp than as a
 * horizontal-scroll surprise.
 */
export const MAX_DIGITS = 6

/** How many digit columns a gutter needs to render `lineCount` without clipping. */
export function digitsForLineCount(lineCount: number): number {
  if (!Number.isFinite(lineCount) || lineCount < 1) return MIN_DIGITS
  const digits = String(Math.floor(lineCount)).length
  return Math.min(MAX_DIGITS, Math.max(MIN_DIGITS, digits))
}

/**
 * How many lines are in this fence?
 *
 * Two very different DOM shapes, depending on whether Typora has initialized
 * the block yet:
 *
 *   - **initialized** — CodeMirror owns the subtree. Each line is its own
 *     `<div>` under `.CodeMirror-code`, so `textContent` has *no* newlines in
 *     it and counting `\n` would always return 1. Count the row divs (or ask
 *     the CodeMirror instance, which is cheaper and exact).
 *
 *   - **not initialized** — the fence still holds the raw source as text.
 *     Typora relies on this itself: `Fences.getValue(cid)` falls back to
 *     `elem.innerText` for exactly the fences that aren't in its `queue`.
 *     Counting newlines is correct here.
 *
 * `excludeSelector` strips UI we inject into the fence (the copy button) so its
 * label doesn't get counted as a line of code.
 */
export function countFenceLines(
  fence: Element,
  cm?: { lineCount(): number } | null,
  excludeSelector = '.tpl-fence-copy',
): number {
  if (cm) {
    try {
      const count = cm.lineCount()
      if (Number.isFinite(count) && count > 0) return count
    } catch {
      // Fall through to DOM counting.
    }
  }

  const rows = fence.querySelectorAll('.CodeMirror-code > div')
  if (rows.length > 0) return rows.length

  // Uninitialized fence: the raw source is still sitting in the element.
  const clone = fence.cloneNode(true) as Element
  clone.querySelectorAll(excludeSelector).forEach(el => el.remove())
  const text = (clone.textContent ?? '').replace(/\n+$/, '')
  return text ? text.split('\n').length : 1
}

/**
 * Write the digit count onto the fence as a custom property.
 *
 * Returns true if the value actually changed — callers use that to skip a
 * redundant style write, which matters because this runs on every mutation
 * inside a code block (i.e. on every keystroke while editing one).
 */
export function applyGutterDigits(fence: HTMLElement, digits: number): boolean {
  const next = String(digits)
  if (fence.style.getPropertyValue('--tpl-lineno-digits') === next) return false
  fence.style.setProperty('--tpl-lineno-digits', next)
  return true
}
