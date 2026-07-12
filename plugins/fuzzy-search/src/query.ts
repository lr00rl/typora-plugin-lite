/**
 * Magic query language for quick-open, à la Google search operators.
 *
 *   type:file    (aliases: f, files)      search file names
 *   type:folder  (aliases: d, dir, folders)  search folder names
 *   type:content (aliases: c, text)       search inside files (ripgrep)
 *   scope:"D000_RTFS/"                     restrict results to a directory
 *
 * Everything not recognized as an operator is the free-text search term.
 * A single parsed query drives all three tabs — the tab only supplies the
 * *default* type/scope when the query doesn't state one. This is the "one
 * common search core" the tabs share.
 *
 * Pure and dependency-light so the grammar, token editing, and autocomplete
 * can be unit-tested without the editor.
 */

import { normalizePrefix } from './dirtree.js'

export type SearchType = 'file' | 'folder' | 'content'

export interface ParsedQuery {
  /** Explicit `type:` operator, resolved through aliases; null if absent. */
  type: SearchType | null
  /** Explicit `scope:` operator, path-normalized (no quotes/slashes); null if absent. */
  scope: string | null
  /** The free-text search terms (operators stripped, collapsed whitespace). */
  terms: string
  /** The original string. */
  raw: string
}

/** Operator keywords the parser recognizes (the left side of `key:value`). */
export const OPERATORS = ['type', 'scope'] as const

const TYPE_ALIASES: Record<string, SearchType> = {
  file: 'file', f: 'file', files: 'file',
  folder: 'folder', d: 'folder', dir: 'folder', dirs: 'folder', folders: 'folder',
  content: 'content', c: 'content', text: 'content',
}

/** Canonical value list per operator, for autocomplete. */
export const TYPE_VALUES: SearchType[] = ['file', 'folder', 'content']

// key : ("quoted value" | unquoted-value). Value may be empty (e.g. `type:`).
const TOKEN_RE = /\b(type|scope)\s*:\s*(?:"([^"]*)"|(\S*))/gi

export function resolveType(value: string): SearchType | null {
  return TYPE_ALIASES[value.trim().toLowerCase()] ?? null
}

/** Parse a raw input string into its operators + free-text terms. */
export function parseQuery(raw: string): ParsedQuery {
  let type: SearchType | null = null
  let scope: string | null = null

  const terms = raw.replace(TOKEN_RE, (_match, key: string, quoted?: string, bare?: string) => {
    const value = (quoted ?? bare ?? '').trim()
    if (key.toLowerCase() === 'type') {
      const resolved = resolveType(value)
      if (resolved) type = resolved
    } else {
      // scope: — empty value clears it; otherwise normalize the path.
      scope = value ? normalizePrefix(value) : null
    }
    return ' ' // replace the token with a space so surrounding terms don't fuse
  }).replace(/\s+/g, ' ').trim()

  return { type, scope, terms, raw }
}

/** The type to actually use: the query's explicit type, else the tab default. */
export function effectiveType(parsed: ParsedQuery, fallback: SearchType): SearchType {
  return parsed.type ?? fallback
}

/** Whether a scope value needs quoting to survive a round-trip through the parser. */
function needsQuoting(value: string): boolean {
  return /\s/.test(value)
}

function formatToken(key: string, value: string): string {
  const v = needsQuoting(value) ? `"${value}"` : value
  return `${key}:${v}`
}

/**
 * Insert or replace a `key:value` token, preserving the rest of the string
 * (including the user's other operators and terms). Used to auto-set `scope:`
 * when the user drills into a folder, and `type:content` when they enter the
 * content tab — without disturbing what they've already typed.
 *
 * An empty `value` removes the token (see removeToken).
 */
export function setToken(raw: string, key: 'type' | 'scope', value: string): string {
  if (value === '') return removeToken(raw, key)

  const token = formatToken(key, value)
  let replaced = false
  const keyRe = new RegExp(`\\b${key}\\s*:\\s*(?:"[^"]*"|\\S*)`, 'i')

  let next: string
  if (keyRe.test(raw)) {
    next = raw.replace(keyRe, () => { replaced = true; return token })
  } else {
    next = raw
  }
  if (!replaced) {
    // Prepend the operator so it reads left-to-right (operators, then terms).
    next = next.trim() ? `${token} ${next.trim()}` : token
  }
  return next.replace(/\s+/g, ' ').replace(/^\s+/, '')
}

/** Remove a `key:...` token, leaving the rest intact. */
export function removeToken(raw: string, key: 'type' | 'scope'): string {
  const keyRe = new RegExp(`\\b${key}\\s*:\\s*(?:"[^"]*"|\\S*)`, 'gi')
  return raw.replace(keyRe, ' ').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

export interface Completion {
  /** Text shown in the candidate list. */
  label: string
  /** The full new input string if this candidate is accepted. */
  insert: string
  /** New cursor position after acceptance. */
  cursor: number
  /** Short hint shown after the label (e.g. file count for a folder). */
  hint?: string
}

export interface CompletionResult {
  /** Candidate completions for the token under the cursor (may be empty). */
  candidates: Completion[]
  /**
   * The greyed suffix to show inline after the cursor for the top candidate
   * (Tab / → accepts it). Empty when there's no unambiguous continuation.
   */
  ghost: string
}

/** The whitespace-delimited token containing `cursor`, and its bounds. */
function tokenAt(raw: string, cursor: number): { text: string; start: number; end: number } {
  let start = cursor
  while (start > 0 && !/\s/.test(raw[start - 1]!)) start--
  let end = cursor
  while (end < raw.length && !/\s/.test(raw[end]!)) end++
  return { text: raw.slice(start, end), start, end }
}

function withToken(raw: string, start: number, end: number, replacement: string): { insert: string; cursor: number } {
  const insert = raw.slice(0, start) + replacement + raw.slice(end)
  return { insert, cursor: start + replacement.length }
}

/**
 * Suggest completions for the operator token under the cursor.
 *
 * Prefix-match only (as requested — no fuzzy): the bare word completes to an
 * operator keyword, `type:x` completes the value, `scope:x` completes against
 * the supplied directory list. `dirs` is a list of `{ path, fileCount }` for
 * scope completion; pass [] when unavailable.
 */
export function completeQuery(
  raw: string,
  cursor: number,
  dirs: ReadonlyArray<{ path: string; fileCount?: number }> = [],
  limit = 8,
): CompletionResult {
  const { text, start, end } = tokenAt(raw, cursor)
  const lower = text.toLowerCase()
  const empty: CompletionResult = { candidates: [], ghost: '' }
  if (!text) return empty

  // scope:PARTIAL → complete directory paths, one path segment at a time (like
  // a shell): the partial splits into a fixed parent and a leaf prefix, and we
  // only offer the parent's immediate children whose name matches the leaf.
  // This keeps `scope:A` from dumping every descendant of every A* folder.
  const scopeMatch = /^scope:(.*)$/i.exec(text)
  if (scopeMatch) {
    const partial = normalizePrefix(scopeMatch[1]!.replace(/^"|"$/g, ''))
    const slash = partial.lastIndexOf('/')
    const parent = slash === -1 ? '' : partial.slice(0, slash)
    const leaf = (slash === -1 ? partial : partial.slice(slash + 1)).toLowerCase()
    const matches = dirs
      .filter(d => {
        const dp = normalizePrefix(d.path)
        const dslash = dp.lastIndexOf('/')
        const dparent = dslash === -1 ? '' : dp.slice(0, dslash)
        const dname = dslash === -1 ? dp : dp.slice(dslash + 1)
        return dparent.toLowerCase() === parent.toLowerCase() && dname.toLowerCase().startsWith(leaf)
      })
      .slice(0, limit)
    const candidates = matches.map(d => {
      const value = normalizePrefix(d.path) + '/'
      const replacement = formatToken('scope', value)
      const { insert, cursor: c } = withToken(raw, start, end, replacement)
      return {
        label: replacement,
        insert,
        cursor: c,
        ...(d.fileCount != null ? { hint: `${d.fileCount} 个文件` } : {}),
      }
    })
    return { candidates, ghost: ghostFor(text, candidates[0]?.label) }
  }

  // type:PARTIAL → complete the value.
  const typeMatch = /^type:(.*)$/i.exec(text)
  if (typeMatch) {
    const partial = typeMatch[1]!.toLowerCase()
    const values = new Set<SearchType>()
    for (const v of TYPE_VALUES) if (v.startsWith(partial)) values.add(v)
    const aliased = resolveType(partial)
    if (aliased) values.add(aliased)
    const candidates = [...values].slice(0, limit).map(v => {
      const replacement = `type:${v}`
      const { insert, cursor: c } = withToken(raw, start, end, replacement)
      return { label: replacement, insert, cursor: c }
    })
    return { candidates, ghost: ghostFor(text, candidates[0]?.label) }
  }

  // bare word that is a prefix of an operator keyword → complete the operator.
  const opMatches = OPERATORS.filter(op => op.startsWith(lower) && op !== lower)
  if (opMatches.length > 0) {
    const candidates = opMatches.slice(0, limit).map(op => {
      const replacement = `${op}:`
      const { insert, cursor: c } = withToken(raw, start, end, replacement)
      return { label: replacement, insert, cursor: c }
    })
    return { candidates, ghost: ghostFor(text, candidates[0]?.label) }
  }

  return empty
}

/** The suffix of `candidate` beyond `typed`, or '' if not a clean prefix. */
function ghostFor(typed: string, candidate: string | undefined): string {
  if (!candidate) return ''
  if (candidate.toLowerCase().startsWith(typed.toLowerCase()) && candidate.length > typed.length) {
    return candidate.slice(typed.length)
  }
  return ''
}
