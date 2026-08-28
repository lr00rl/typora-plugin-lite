/**
 * Path math for wiki-link targets and graph-relative resolution.
 *
 * Everything here is pure (no core imports) so the unit tests can load the
 * module directly. `wikiTargetFor` writes the same shape the vault's own
 * resolver reads back: a path relative to the current note, without the .md
 * extension, so a link inserted from the palette resolves exactly like one
 * typed by hand. The resolver it has to agree with is `Vault.resolve` in the
 * vault repo's `.tools/vault.mjs`; it used to be described as mirroring a
 * block generator that has since been retired along with the blocks.
 */

export function normalizePath(input: string): string {
  return input.replace(/\\/g, '/')
}

export function splitPath(input: string): string[] {
  return normalizePath(input).split('/').filter(Boolean)
}

export function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim()) return value
  }
  return ''
}

function getRootPrefix(input: string): string {
  const normalized = normalizePath(input)
  const drive = normalized.match(/^[A-Za-z]:/)
  if (drive) return drive[0].toLowerCase()
  return normalized.startsWith('/') ? '/' : ''
}

function isAbsolutePath(input: string): boolean {
  return !!getRootPrefix(input)
}

function extnameOf(input: string): string {
  const base = normalizePath(input).split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

function dirnameOf(input: string): string {
  const normalized = normalizePath(input)
  const idx = normalized.lastIndexOf('/')
  if (idx < 0) return ''
  if (idx === 0) return '/'
  return normalized.slice(0, idx)
}

function joinPath(base: string, child: string): string {
  if (!base) return normalizePath(child)
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  return `${trimmed}/${normalizePath(child)}`
}

/** Fold `.`/`..` segments; `target` may itself be absolute. */
function resolvePath(baseDir: string, target: string): string {
  const normalizedTarget = normalizePath(target)
  if (isAbsolutePath(normalizedTarget)) return collapseSegments(normalizedTarget)
  return collapseSegments(joinPath(baseDir, normalizedTarget))
}

function collapseSegments(input: string): string {
  const prefix = getRootPrefix(input)
  const body = prefix ? input.slice(prefix.length) : input
  const out: string[] = []
  for (const seg of splitPath(body)) {
    if (seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!prefix) out.push('..')
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  if (prefix === '/') return `/${joined}`
  if (prefix) return `${prefix}${joined ? `/${joined}` : ''}`
  return joined || '.'
}

export function relPathFromRoot(absPath: string, root: string): string {
  const normalizedAbs = normalizePath(absPath)
  const normalizedRoot = normalizePath(root)
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : normalizedRoot + '/'
  if (normalizedAbs.startsWith(prefix)) {
    return normalizedAbs.slice(prefix.length)
  }
  return normalizedAbs
}

export function relPathFromDir(absPath: string, baseDir: string): string {
  const target = normalizePath(absPath)
  const base = normalizePath(baseDir)
  if (!base || getRootPrefix(target) !== getRootPrefix(base)) return target

  const targetParts = splitPath(target)
  const baseParts = splitPath(base)
  let shared = 0
  while (
    shared < targetParts.length &&
    shared < baseParts.length &&
    targetParts[shared] === baseParts[shared]
  ) {
    shared += 1
  }

  const up = baseParts.slice(shared).map(() => '..')
  const down = targetParts.slice(shared)
  return [...up, ...down].join('/') || '.'
}

export function withoutMarkdownExt(input: string): string {
  return input.replace(/\.(md|markdown)$/i, '')
}

/** Human title for a wiki target when the graph has no entry for it. */
export function deriveTitleFromTarget(rawTarget: string): string {
  const withoutHeading = rawTarget.split('#')[0]
  const base = withoutMarkdownExt(withoutHeading)
  const name = normalizePath(base).split('/').filter(Boolean).pop() || base
  return name.replace(/[_-]+/g, ' ').trim() || name
}

/**
 * The `[[target]]` text for linking from `currentFile` to the note at
 * `relPath` (root-relative). Byte-compatible with the vault generator.
 */
export function wikiTargetFor(relPath: string, currentFile: string, rootDir: string): string {
  const absTarget = joinPath(normalizePath(rootDir), relPath)
  const currentDir = dirnameOf(normalizePath(currentFile))
  return withoutMarkdownExt(relPathFromDir(absTarget, currentDir))
}

export interface TargetResolution {
  normalizedTarget: string
  candidates: string[]
}

/**
 * Absolute-path candidates for a raw `[[...]]` target, in priority order:
 * relative to the current file first, then vault-root relative, each with
 * inferred markdown extensions when the target has none.
 */
export function targetCandidates(rawTarget: string, currentFile: string, rootDir: string): TargetResolution {
  const normalizedTarget = rawTarget.split('#')[0].trim()
  const candidates = new Set<string>()

  if (!normalizedTarget) {
    return { normalizedTarget, candidates: [] }
  }

  const currentDir = dirnameOf(normalizePath(currentFile))
  const resolved = resolvePath(currentDir, normalizedTarget)
  candidates.add(resolved)
  if (!extnameOf(resolved)) {
    candidates.add(`${resolved}.md`)
    candidates.add(`${resolved}.markdown`)
  }

  if (rootDir && !isAbsolutePath(normalizedTarget)) {
    const rootCandidate = resolvePath(normalizePath(rootDir), normalizedTarget)
    candidates.add(rootCandidate)
    if (!extnameOf(rootCandidate)) {
      candidates.add(`${rootCandidate}.md`)
      candidates.add(`${rootCandidate}.markdown`)
    }
  }

  return { normalizedTarget, candidates: [...candidates] }
}

function basenameWithoutExt(input: string): string {
  const base = normalizePath(input).split('/').filter(Boolean).pop() || ''
  return withoutMarkdownExt(base)
}

/**
 * Last-resort resolution for a moved note: every relPath whose basename
 * matches the target's (extension-insensitive). Mirrors the vault pipeline's
 * resolver: a unique basename match heals a broken link after a move; ties
 * are for the caller to disambiguate (same-directory preference).
 */
export function findByBasename(relPaths: Iterable<string>, rawTarget: string): string[] {
  const wanted = basenameWithoutExt(rawTarget.split('#')[0].trim())
  if (!wanted) return []
  const matches: string[] = []
  for (const relPath of relPaths) {
    if (basenameWithoutExt(relPath) === wanted) matches.push(relPath)
  }
  return matches
}
