/**
 * Finder-style path navigation for quick-open.
 *
 * Typing `/` as the first character switches the list from "search the index"
 * to "walk a path", the way Finder's Go-to-Folder and a shell prompt do. The
 * grammar is deliberately tiny:
 *
 *   /            the root of the folder Typora currently has open
 *   //           the root of the real filesystem
 *   ~/           the home directory
 *
 * Everything after the prefix is a literal path. The segment after the last
 * `/` is not part of the path yet: it is a prefix filter over the listing of
 * its parent, which is what makes typing and completing feel like one motion
 * instead of two modes.
 *
 * This module is pure string and array work with no editor or filesystem
 * imports, so the grammar, the dotfile rule, and completion are unit-testable
 * without a browser. Paths are handled in posix form; the caller converts.
 */

export type PathRootKind = 'workspace' | 'filesystem' | 'home'

export interface PathRoots {
  /** Absolute path of the folder Typora has open; '' when there is none. */
  workspace: string
  /** Absolute path of the user's home directory; '' when unknown. */
  home: string
}

export interface PathQuery {
  kind: PathRootKind
  /** Absolute directory whose children should be listed. */
  dir: string
  /** Prefix filter for the final, partially typed segment ('' lists everything). */
  leaf: string
  /** The normalized input this was parsed from. */
  typed: string
}

export interface PathEntry {
  name: string
  isDirectory: boolean
}

/** True when `typed` should be handled as a path rather than a search term. */
export function isPathQuery(typed: string): boolean {
  return typed.startsWith('/') || typed === '~' || typed.startsWith('~/')
}

function collapse(segments: string[]): string[] {
  const out: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') { out.pop(); continue }
    out.push(segment)
  }
  return out
}

/**
 * Join an absolute root with a relative remainder, folding `.` and `..`.
 *
 * The base is folded together with the remainder rather than prepended to it,
 * so a leading `..` climbs out of the root instead of being silently dropped.
 */
export function joinPath(root: string, rest: string): string {
  const normalizedRoot = root.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(normalizedRoot)?.[0] ?? ''
  const baseSegments = normalizedRoot.slice(drive.length).split('/').filter(Boolean)
  const restSegments = rest.replace(/\\/g, '/').split('/')
  const segments = collapse([...baseSegments, ...restSegments])
  return `${drive}/${segments.join('/')}`.replace(/\/$/, '') || `${drive}/`
}

/**
 * Parse typed input into the directory to list and the prefix to filter by.
 * Returns null when the input is not a path query.
 *
 * `//` is checked before `/` so the filesystem root wins over the workspace
 * root; the two only differ by one character and the order is the whole
 * distinction.
 */
export function parsePathQuery(rawTyped: string, roots: PathRoots): PathQuery | null {
  const typed = rawTyped === '~' ? '~/' : rawTyped
  if (!isPathQuery(typed)) return null

  let kind: PathRootKind
  let root: string
  let rest: string

  if (typed.startsWith('//')) {
    kind = 'filesystem'
    root = ''            // joinPath('' , x) yields an absolute /x
    rest = typed.slice(2)
  } else if (typed.startsWith('~/')) {
    kind = 'home'
    root = roots.home
    rest = typed.slice(2)
  } else {
    kind = 'workspace'
    // With no folder open there is no workspace root to anchor to; the real
    // filesystem root is the only honest fallback.
    root = roots.workspace
    rest = typed.slice(1)
    if (!root) kind = 'filesystem'
  }

  const slash = rest.lastIndexOf('/')
  const dirPart = slash === -1 ? '' : rest.slice(0, slash)
  const leaf = slash === -1 ? rest : rest.slice(slash + 1)

  return { kind, dir: joinPath(root, dirPart), leaf, typed }
}

/**
 * Filter and order a directory listing for display.
 *
 * Directories first, then files, each case-insensitive by name — the ordering
 * a file tree uses. Dotfiles stay hidden until the typed segment starts with a
 * dot, which is the Finder rule and means the common case is never cluttered
 * while the deliberate case still works.
 */
export function filterEntries(entries: readonly PathEntry[], leaf: string): PathEntry[] {
  const needle = leaf.toLowerCase()
  const wantHidden = leaf.startsWith('.')
  const matched = entries.filter(entry => {
    if (!wantHidden && entry.name.startsWith('.')) return false
    return !needle || entry.name.toLowerCase().startsWith(needle)
  })
  return matched.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name)
  })
}

/** Replace the partially typed final segment with `name`. */
export function withLeaf(typed: string, name: string): string {
  const normalized = typed === '~' ? '~/' : typed
  const slash = normalized.lastIndexOf('/')
  return normalized.slice(0, slash + 1) + name
}

/**
 * Drop the final path segment, the way Backspace at an empty prompt walks up a
 * directory in a shell. `/a/b/` climbs to `/a/`, `/a/bc` first clears the
 * partial segment to `/a/`. Stops at the prefix so the mode is never exited by
 * accident; deleting the last `/` is a deliberate keystroke.
 */
export function parentInput(typed: string): string {
  const normalized = typed === '~' ? '~/' : typed
  const prefix = normalized.startsWith('//') ? '//' : normalized.startsWith('~/') ? '~/' : '/'
  const rest = normalized.slice(prefix.length)
  if (!rest) return prefix
  if (!rest.endsWith('/')) return prefix + rest.slice(0, rest.lastIndexOf('/') + 1)
  const trimmed = rest.slice(0, -1)
  return prefix + trimmed.slice(0, trimmed.lastIndexOf('/') + 1)
}

/** The longest string every candidate starts with, case-sensitively. */
export function commonPrefix(names: readonly string[]): string {
  if (!names.length) return ''
  let prefix = names[0]!
  for (const name of names.slice(1)) {
    let i = 0
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) break
  }
  return prefix
}

export interface PathCompletion {
  /** Full input string if this candidate is accepted. */
  insert: string
  /** Text shown on the chip. */
  label: string
  isDirectory: boolean
}

/**
 * Completion for the typed segment.
 *
 * `ghost` is the shared continuation of every match, so Tab always advances by
 * the largest amount that cannot be wrong — one unambiguous candidate completes
 * fully, several complete to their common prefix, exactly like a shell.
 */
export function completePath(
  typed: string,
  entries: readonly PathEntry[],
  limit = 8,
): { candidates: PathCompletion[]; ghost: string } {
  const normalized = typed === '~' ? '~/' : typed
  const slash = normalized.lastIndexOf('/')
  const leaf = normalized.slice(slash + 1)
  const matches = filterEntries(entries, leaf)
  if (!matches.length) return { candidates: [], ghost: '' }

  const shared = commonPrefix(matches.map(entry => entry.name))
  const ghost = shared.length > leaf.length ? shared.slice(leaf.length) : ''

  const candidates = matches.slice(0, limit).map(entry => ({
    insert: withLeaf(normalized, entry.name) + (entry.isDirectory ? '/' : ''),
    label: entry.name + (entry.isDirectory ? '/' : ''),
    isDirectory: entry.isDirectory,
  }))
  return { candidates, ghost }
}

/** Human-readable label for the location bar. */
export function describeRoot(kind: PathRootKind): string {
  return kind === 'workspace' ? '当前目录' : kind === 'home' ? '主目录' : '文件系统'
}
