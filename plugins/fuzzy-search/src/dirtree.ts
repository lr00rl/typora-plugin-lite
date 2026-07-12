/**
 * Directory browsing derived from the flat file index.
 *
 * The index is a flat list of workspace-relative file paths. To let quick-open
 * stand in for the sidebar tree, we need to answer "what's directly inside this
 * folder?" — the immediate subfolders and files at a given prefix — without
 * building or maintaining a real tree structure. These are pure functions over
 * the flat list, so browse mode has no separate state to keep in sync with the
 * index and the logic is fully unit-testable.
 */

export interface DirChild {
  /** Display name (the final path segment). */
  name: string
  /** Workspace-relative path. Directories have no trailing slash. */
  path: string
  kind: 'dir' | 'file'
  /** For directories: how many files live anywhere beneath it. */
  fileCount: number
}

/** Normalize a browse prefix to `''` (root) or `'a/b'` with no leading/trailing slash. */
export function normalizePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Immediate children of `prefix` within the flat file list.
 *
 * A file `a/b/c.md` contributes:
 *   - at prefix ''    → directory `a`
 *   - at prefix 'a'   → directory `a/b`
 *   - at prefix 'a/b' → file `a/b/c.md`
 *
 * Directories are collapsed (one entry per immediate subfolder, with a count of
 * everything beneath it) and sorted folders-first, then case-insensitively by
 * name — the ordering a file tree uses.
 */
export function listChildren(paths: readonly string[], prefix: string): DirChild[] {
  const base = normalizePrefix(prefix)
  const prefixSegments = base ? base.split('/') : []
  const depth = prefixSegments.length

  const dirs = new Map<string, number>() // dir path → file count beneath
  const files: DirChild[] = []

  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path) continue
    const segments = path.split('/')

    // Must live under `base`: the first `depth` segments have to match exactly.
    if (segments.length <= depth) continue
    let underPrefix = true
    for (let i = 0; i < depth; i++) {
      if (segments[i] !== prefixSegments[i]) { underPrefix = false; break }
    }
    if (!underPrefix) continue

    if (segments.length === depth + 1) {
      // Direct file child.
      files.push({ name: segments[depth]!, path, kind: 'file', fileCount: 0 })
    } else {
      // Nested deeper → its first segment past the prefix is an immediate subdir.
      const dirName = segments[depth]!
      const dirPath = base ? `${base}/${dirName}` : dirName
      dirs.set(dirPath, (dirs.get(dirPath) ?? 0) + 1)
    }
  }

  const dirChildren: DirChild[] = [...dirs.entries()].map(([path, fileCount]) => ({
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    kind: 'dir',
    fileCount,
  }))

  const byName = (a: DirChild, b: DirChild) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name)

  dirChildren.sort(byName)
  files.sort(byName)
  return [...dirChildren, ...files]
}

/** Parent of a browse prefix (`'a/b'` → `'a'`, `'a'` → `''`, `''` → `''`). */
export function parentPrefix(prefix: string): string {
  const base = normalizePrefix(prefix)
  if (!base) return ''
  const idx = base.lastIndexOf('/')
  return idx === -1 ? '' : base.slice(0, idx)
}

/** Breadcrumb segments for display, root first. `''` yields `[]`. */
export function breadcrumbs(prefix: string): Array<{ name: string; path: string }> {
  const base = normalizePrefix(prefix)
  if (!base) return []
  const segments = base.split('/')
  const crumbs: Array<{ name: string; path: string }> = []
  let acc = ''
  for (const segment of segments) {
    acc = acc ? `${acc}/${segment}` : segment
    crumbs.push({ name: segment, path: acc })
  }
  return crumbs
}
