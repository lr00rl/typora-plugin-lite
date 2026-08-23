/**
 * Fuzzy subsequence matching for the palette filter.
 *
 * `fuzzyMatchPositions` is copied from plugins/fuzzy-search/src/scoring.ts
 * (kept in sync by hand): the palette's scopes are pre-ranked by the graph, so
 * only match-or-not plus highlight positions are needed here — re-ranking with
 * fzf scores would fight the graph's ordering. Matching is a code-unit
 * subsequence over lowercased text, which is CJK-safe as-is (Han characters
 * are BMP and lowercase-invariant).
 */

/** Positions in `text` that the fuzzy match consumed, or null if it doesn't match. */
export function fuzzyMatchPositions(text: string, query: string): number[] | null {
  const t = text.toLowerCase()
  const q = query.toLowerCase().trim()
  if (!q) return []

  const positions: number[] = []
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      positions.push(ti)
      qi += 1
    }
  }
  return qi === q.length ? positions : null
}
