/**
 * Pure content-search ranking and ripgrep output parsing.
 *
 * The shell integration lives in main.ts; this module turns a bounded set of
 * ripgrep JSON events into stable, relevance-ranked UI records. Keeping it
 * independent of Typora makes the score floor and context contract directly
 * testable instead of burying them in DOM code.
 */

export const CONTENT_MIN_SCORE = 0.44

/**
 * Adaptive input debounce for content search.
 *
 * One- and two-character queries fan out across far more files, so they get a
 * longer quiet period. A precise query can start sooner. Empty input remains
 * quick so deleting a query returns to the resting view without feeling sticky.
 */
export function contentSearchDebounceDelay(terms: string): number {
  const length = Array.from(terms.trim()).length
  if (length === 0) return 120
  if (length === 1) return 420
  if (length === 2) return 320
  return 240
}

export interface ContentSearchFailureCopy {
  kind: 'timeout' | 'failure'
  message: string
  footer: string
}

/**
 * Turn an internal shell failure into safe, actionable UI copy.
 *
 * Shell errors can contain the complete command, including every absolute
 * candidate path. Those details belong in neither the DOM nor an aria-live
 * announcement, where they are both noisy and a local-information leak.
 */
export function contentSearchFailureCopy(error: unknown): ContentSearchFailureCopy {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === 'string' ? error : ''
  const timedOut = /(?:\btimeout\b|timed out|etimedout)/i.test(detail)
  if (timedOut) {
    return {
      kind: 'timeout',
      message: '内容搜索超时。请增加关键词，或使用 scope: 缩小搜索目录后重试。',
      footer: '内容搜索超时',
    }
  }
  return {
    kind: 'failure',
    message: '内容搜索暂时失败。请重试；如持续发生，请使用 scope: 缩小搜索目录。',
    footer: '内容搜索失败',
  }
}

export interface RgFileCount {
  path: string
  count: number
}

export interface ContentContextLine {
  line: number
  text: string
  kind: 'before' | 'match' | 'after'
}

export interface ContentMatch {
  absPath: string
  relPath: string
  basename: string
  line: number
  col: number
  matchText: string
  score: number
  contextLines: ContentContextLine[]
}

export interface ContentRankOptions {
  root: string
  limit: number
  minScore?: number
  fileHitCounts?: ReadonlyMap<string, number>
}

interface ParsedRgLine {
  path: string
  line: number
  text: string
  isMatch: boolean
  col: number
}

interface RgJsonEvent {
  type?: unknown
  data?: {
    path?: { text?: unknown }
    lines?: { text?: unknown }
    line_number?: unknown
    submatches?: Array<{ start?: unknown }>
  }
}

export interface HighlightRange {
  start: number
  end: number
}

/** Whitespace-delimited terms, preserving the first spelling and order. */
export function tokenizeContentQuery(query: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const term of query.trim().split(/\s+/).filter(Boolean)) {
    const key = term.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
  }
  return terms
}

/** Parse `rg --count-matches --with-filename` without breaking colon paths. */
export function parseRgFileCounts(stdout: string): RgFileCount[] {
  const counts: RgFileCount[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    const match = /^(.*):(\d+)$/.exec(line)
    if (!match?.[1] || !match[2]) continue
    const count = Number.parseInt(match[2], 10)
    if (!Number.isFinite(count) || count <= 0) continue
    counts.push({ path: normalizePath(match[1]), count })
  }
  return counts
}

/** Select the files most likely to contain useful excerpts before fetching text. */
export function selectContentCandidateFiles(
  counts: ReadonlyArray<RgFileCount>,
  limit: number,
): { paths: string[]; totalFiles: number; truncated: boolean } {
  const boundedLimit = Math.max(0, Math.floor(limit))
  const sorted = [...counts].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
  return {
    paths: sorted.slice(0, boundedLimit).map(item => item.path),
    totalFiles: sorted.length,
    truncated: sorted.length > boundedLimit,
  }
}

/** Exact, case-insensitive ranges for quiet content highlighting. */
export function findContentHighlightRanges(
  text: string,
  terms: ReadonlyArray<string>,
): HighlightRange[] {
  const haystack = text.toLocaleLowerCase()
  const ranges: HighlightRange[] = []
  for (const rawTerm of terms) {
    const term = rawTerm.toLocaleLowerCase()
    if (!term) continue
    let from = 0
    while (from <= haystack.length - term.length) {
      const start = haystack.indexOf(term, from)
      if (start < 0) break
      ranges.push({ start, end: start + term.length })
      from = start + Math.max(1, term.length)
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)

  const merged: HighlightRange[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

export function parseAndRankContentMatches(
  stdout: string,
  query: string,
  options: ContentRankOptions,
): ContentMatch[] {
  const terms = tokenizeContentQuery(query)
  if (terms.length === 0 || options.limit <= 0) return []

  const parsedLines = parseRgJsonLines(stdout)
  const lineMaps = new Map<string, Map<number, ParsedRgLine>>()
  for (const line of parsedLines) {
    let lines = lineMaps.get(line.path)
    if (!lines) {
      lines = new Map()
      lineMaps.set(line.path, lines)
    }
    // A match event is richer than a context event for the same line.
    const existing = lines.get(line.line)
    if (!existing || line.isMatch) lines.set(line.line, line)
  }

  const minScore = options.minScore ?? CONTENT_MIN_SCORE
  const root = normalizePath(options.root).replace(/\/$/, '')
  const matches: ContentMatch[] = []
  for (const line of parsedLines) {
    if (!line.isMatch) continue
    const lines = lineMaps.get(line.path)
    const absPath = resolvePath(line.path, root)
    const relPath = relativePath(absPath, root)
    const basename = pathBasename(absPath)
    const before = lines?.get(line.line - 1)
    const after = lines?.get(line.line + 1)
    const contextLines: ContentContextLine[] = []
    if (before) contextLines.push({ line: before.line, text: before.text, kind: 'before' })
    contextLines.push({ line: line.line, text: line.text, kind: 'match' })
    if (after) contextLines.push({ line: after.line, text: after.text, kind: 'after' })

    const score = scoreContentMatch({
      query,
      terms,
      line: line.text,
      before: before?.text ?? '',
      after: after?.text ?? '',
      basename,
      relPath,
    })
    if (score < minScore) continue

    matches.push({
      absPath,
      relPath,
      basename,
      line: line.line,
      col: line.col,
      matchText: line.text,
      score,
      contextLines,
    })
  }

  const hitCounts = options.fileHitCounts
  return matches
    .sort((a, b) => (
      b.score - a.score
      || (hitCounts?.get(b.absPath) ?? 0) - (hitCounts?.get(a.absPath) ?? 0)
      || a.relPath.localeCompare(b.relPath)
      || a.line - b.line
    ))
    .slice(0, Math.max(0, Math.floor(options.limit)))
}

function parseRgJsonLines(stdout: string): ParsedRgLine[] {
  const lines: ParsedRgLine[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw) continue
    let event: RgJsonEvent
    try {
      event = JSON.parse(raw) as RgJsonEvent
    } catch {
      continue
    }
    if (event.type !== 'match' && event.type !== 'context') continue
    const path = event.data?.path?.text
    const text = event.data?.lines?.text
    const line = event.data?.line_number
    if (typeof path !== 'string' || typeof text !== 'string' || typeof line !== 'number') continue
    const firstStart = event.data?.submatches?.[0]?.start
    lines.push({
      path: normalizePath(path),
      line,
      text: text.replace(/\r?\n$/, ''),
      isMatch: event.type === 'match',
      col: typeof firstStart === 'number' ? firstStart + 1 : 1,
    })
  }
  return lines
}

function scoreContentMatch(input: {
  query: string
  terms: ReadonlyArray<string>
  line: string
  before: string
  after: string
  basename: string
  relPath: string
}): number {
  const line = input.line.toLocaleLowerCase()
  const context = `${input.before}\n${input.after}`.toLocaleLowerCase()
  const basename = input.basename.toLocaleLowerCase()
  const relPath = input.relPath.toLocaleLowerCase()
  const loweredTerms = input.terms.map(term => term.toLocaleLowerCase())

  let locationTotal = 0
  let covered = 0
  let occurrenceTotal = 0
  const lineRanges: HighlightRange[] = []
  for (const term of loweredTerms) {
    const lineAt = line.indexOf(term)
    if (lineAt >= 0) {
      locationTotal += 1
      covered += 1
      lineRanges.push({ start: lineAt, end: lineAt + term.length })
    } else if (context.includes(term)) {
      locationTotal += 0.64
      covered += 1
    } else if (basename.includes(term)) {
      locationTotal += 0.32
      covered += 1
    } else if (relPath.includes(term)) {
      locationTotal += 0.18
      covered += 1
    }
    occurrenceTotal += countOccurrences(line, term)
  }

  const termCount = Math.max(1, loweredTerms.length)
  let score = (locationTotal / termCount) * 0.62
  if (covered === termCount) score += 0.06

  const phrase = normalizeSearchText(input.query)
  const normalizedLine = normalizeSearchText(input.line)
  const normalizedContext = normalizeSearchText(`${input.before} ${input.line} ${input.after}`)
  if (phrase && normalizedLine.includes(phrase)) score += 0.22
  else if (phrase && normalizedContext.includes(phrase)) score += 0.1

  if (loweredTerms.length > 1 && lineRanges.length === loweredTerms.length) {
    const first = Math.min(...lineRanges.map(range => range.start))
    const last = Math.max(...lineRanges.map(range => range.end))
    const span = last - first
    const closeness = 1 - Math.min(1, Math.max(0, span - phrase.length) / Math.max(24, line.length))
    score += closeness * 0.1
  }

  score += Math.min(1, occurrenceTotal / (termCount * 3)) * 0.05
  return Math.max(0, Math.min(1, score))
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0
  let count = 0
  let from = 0
  while (from <= text.length - term.length) {
    const at = text.indexOf(term, from)
    if (at < 0) break
    count += 1
    from = at + term.length
  }
  return count
}

function normalizeSearchText(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function resolvePath(path: string, root: string): string {
  const normalized = normalizePath(path)
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return normalized
  return root ? `${root}/${normalized}` : normalized
}

function relativePath(path: string, root: string): string {
  if (!root) return path
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function pathBasename(path: string): string {
  const parts = normalizePath(path).split('/')
  return parts[parts.length - 1] ?? path
}
