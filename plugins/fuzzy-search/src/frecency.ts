/**
 * Frecency: rank files by a blend of how *recently* and how *frequently* they
 * were opened. Pure recency (a plain MRU list) forgets that a file you open ten
 * times a day matters more than one you touched once last night; pure frequency
 * never lets go of a file you opened constantly last month and never since.
 * Frecency is the standard fix (Firefox's address bar, editor "recent files"),
 * and it's what makes an empty-query quick-open feel like it already knows what
 * you want — the thing that lets it stand in for a file tree.
 *
 * The whole model is pure and serializable so it can be unit-tested and
 * persisted in plugin settings without a live editor.
 */

export interface FrecencyEntry {
  /** Absolute path of the file. */
  path: string
  /** How many times it has been opened. */
  count: number
  /** Epoch ms of the most recent open. */
  lastOpenedAt: number
}

export type FrecencyStore = Record<string, FrecencyEntry>

/** Frequency stops accumulating weight past this many opens. */
export const FREQUENCY_CAP = 50

/**
 * Recency weight by age of the last open. Bucketed rather than a smooth decay
 * so the scores are legible and testable: everything opened in the last hour
 * shares the top band, and the bands step down over a quarter.
 */
export function recencyWeight(ageMs: number): number {
  if (ageMs < 0) return 100 // clock skew — treat as "just now"
  const HOUR = 3_600_000
  const DAY = 24 * HOUR
  if (ageMs <= HOUR) return 100
  if (ageMs <= DAY) return 80
  if (ageMs <= 7 * DAY) return 60
  if (ageMs <= 30 * DAY) return 40
  if (ageMs <= 90 * DAY) return 20
  return 10
}

/**
 * Combined frecency score. Recency dominates (a file you opened this hour beats
 * one you opened 40 times last month), with frequency as a capped tie-breaker
 * so a heavily-used file doesn't get buried by one incidental recent open.
 */
export function frecencyScore(entry: FrecencyEntry, now: number): number {
  return recencyWeight(now - entry.lastOpenedAt) + Math.min(entry.count, FREQUENCY_CAP) * 2
}

/** Record an open, returning a new store (never mutates the input). */
export function recordOpen(store: FrecencyStore, path: string, now: number): FrecencyStore {
  const existing = store[path]
  return {
    ...store,
    [path]: {
      path,
      count: (existing?.count ?? 0) + 1,
      lastOpenedAt: now,
    },
  }
}

/**
 * Paths ranked by frecency, highest first. `filter` drops entries whose file no
 * longer exists (the caller checks the filesystem); it defaults to keeping all.
 */
export function rankByFrecency(
  store: FrecencyStore,
  now: number,
  filter: (path: string) => boolean = () => true,
): string[] {
  return Object.values(store)
    .filter(entry => filter(entry.path))
    .map(entry => ({ path: entry.path, score: frecencyScore(entry, now) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map(entry => entry.path)
}

/**
 * A bounded search-ranking bonus for a file's frecency. Added to a fuzzy match
 * score so frequently/recently opened files that also match the query rank
 * higher — without letting frecency swamp a much stronger textual match. Files
 * absent from the store contribute nothing.
 */
export const FRECENCY_SEARCH_BOOST_CAP = 40

export function frecencySearchBoost(store: FrecencyStore, path: string, now: number): number {
  const entry = store[path]
  if (!entry) return 0
  // frecencyScore maxes near 100 + cap*2; scale it into a modest, bounded lift.
  const raw = frecencyScore(entry, now) * 0.2
  return Math.min(FRECENCY_SEARCH_BOOST_CAP, raw)
}

/**
 * Drop the least-frecent entries once the store grows past `max`, so it doesn't
 * accrete stale paths forever. Keeps the top `max` by frecency.
 */
export function pruneStore(store: FrecencyStore, now: number, max: number): FrecencyStore {
  const paths = rankByFrecency(store, now)
  if (paths.length <= max) return store
  const keep = new Set(paths.slice(0, max))
  const next: FrecencyStore = {}
  for (const path of keep) {
    const entry = store[path]
    if (entry) next[path] = entry
  }
  return next
}

/**
 * Remove exactly the given paths (files confirmed to no longer exist), leaving
 * every other entry untouched.
 *
 * The subtlety this guards: callers verify existence for only a *slice* of the
 * store (the visible recent list), so pruning must key off the confirmed-missing
 * set, never off "which of the checked paths survived" — the latter would delete
 * every entry the caller didn't look at.
 */
export function removePaths(store: FrecencyStore, missing: Iterable<string>): FrecencyStore {
  const drop = missing instanceof Set ? missing : new Set(missing)
  if (drop.size === 0) return store
  const next: FrecencyStore = {}
  for (const [path, entry] of Object.entries(store)) {
    if (!drop.has(path)) next[path] = entry
  }
  return next
}

/**
 * Read a persisted store defensively. Historically the plugin stored a plain
 * MRU array of paths; migrate that to a frecency store (recency preserved by
 * position, frequency seeded to 1) so upgrading users don't lose their history.
 */
export function loadStore(raw: unknown, now: number): FrecencyStore {
  if (Array.isArray(raw)) {
    // Legacy MRU: index 0 is most recent. Space the synthesized timestamps so
    // the original order survives as a recency gradient.
    const store: FrecencyStore = {}
    raw.forEach((path, i) => {
      if (typeof path !== 'string' || !path) return
      store[path] = { path, count: 1, lastOpenedAt: now - i * 1000 }
    })
    return store
  }
  if (raw && typeof raw === 'object') {
    const store: FrecencyStore = {}
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = value as Partial<FrecencyEntry>
      if (typeof entry?.count === 'number' && typeof entry?.lastOpenedAt === 'number') {
        store[path] = { path, count: entry.count, lastOpenedAt: entry.lastOpenedAt }
      }
    }
    return store
  }
  return {}
}
