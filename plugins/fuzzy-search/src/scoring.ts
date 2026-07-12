/**
 * Fuzzy matching + candidate scoring, extracted from main.ts so it can be unit
 * tested without loading the editor core, and so the frecency-aware ranking has
 * a single home.
 *
 * `fzfScore` is an fzf-inspired subsequence scorer: it rewards consecutive
 * runs, word boundaries, camelCase humps, and an exact prefix, and lightly
 * penalizes a wide match span and a long tail. `scoreCandidate` runs it against
 * the three keys a file offers (basename, workspace-relative path, path
 * relative to the current file) and blends in a bounded frecency bonus, so a
 * file you open constantly floats up among otherwise comparable matches.
 */

export interface ScoreKeys {
  /** lowercased basename */
  basenameKey: string
  /** lowercased workspace-relative path */
  relPathKey: string
  /** lowercased path relative to the current file's directory */
  cwdRelPathKey: string
}

export interface ScoreOptions {
  /** The query looks like a path (has a slash or ./ ../ prefix). */
  isPathQuery: boolean
  /** Bounded frecency lift for this file; 0 when unknown. */
  frecencyBoost?: number
}

export function fzfScore(text: string, query: string): number {
  const t = text.toLowerCase()
  const q = query.toLowerCase()

  const positions: number[] = []
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) { positions.push(ti); qi++ }
  }
  if (qi < q.length) return -Infinity

  let score = 100
  let prevPos = -2
  let consecutive = 0

  for (const pos of positions) {
    if (pos === prevPos + 1) {
      consecutive++
      score += consecutive * 6
    } else {
      consecutive = 0
    }
    const prevCh = pos > 0 ? t[pos - 1] : ''
    if (pos === 0 || /[\\/\-_.\s]/.test(prevCh)) score += 10
    // camelCase boundary
    if (pos > 0 && text[pos] !== text[pos].toLowerCase() && text[pos - 1] === text[pos - 1].toLowerCase()) {
      score += 8
    }
    if (pos === 0) score += 12
    prevPos = pos
  }

  // Exact prefix bonus
  if (t.startsWith(q)) score += 20

  const span = positions[positions.length - 1]! - positions[0]! + 1
  score -= span * 0.4
  score -= (t.length - q.length) * 0.1
  return score
}

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

/**
 * Best score for a file across its three keys, plus frecency. Returns
 * -Infinity when the query matches none of the keys (so the caller drops it).
 *
 * The per-key constants preserve main.ts's original weighting: basename beats
 * workspace path beats cwd-relative path, unless the query itself looks like a
 * path, in which case the cwd-relative key is favoured.
 */
export function scoreCandidate(keys: ScoreKeys, query: string, options: ScoreOptions): number {
  const nameScore = fzfScore(keys.basenameKey, query) + 25
  const rootPathScore = fzfScore(keys.relPathKey, query) + 8
  const cwdPathScore = fzfScore(keys.cwdRelPathKey, query) + (options.isPathQuery ? 20 : 14)

  const best = Math.max(nameScore, rootPathScore, cwdPathScore)
  if (best === -Infinity) return -Infinity
  return best + (options.frecencyBoost ?? 0)
}
