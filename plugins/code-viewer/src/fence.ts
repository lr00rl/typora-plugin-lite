/**
 * Text/binary classification for the code viewer.
 *
 * The viewer paints file contents into a read-only pane, which is meaningless
 * for a binary blob (an image, a compiled artifact) and slow to build a DOM
 * for. Callers check isProbablyBinary first and show a notice instead.
 */

/**
 * Heuristic: does this look like binary rather than text? A NUL byte is the
 * classic tell (no valid UTF-8 text contains U+0000); we also bail if a sizable
 * sample is dominated by other non-printable control characters.
 *
 * `sampleSize` caps the scan so a huge file is cheap to classify.
 */
export function isProbablyBinary(content: string, sampleSize = 8192): boolean {
  const n = Math.min(content.length, sampleSize)
  if (n === 0) return false
  let control = 0
  for (let i = 0; i < n; i++) {
    const code = content.charCodeAt(i)
    if (code === 0) return true // NUL → definitely binary
    // Allow tab (9), LF (10), CR (13); count other C0 controls.
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control++
  }
  return control / n > 0.15
}
