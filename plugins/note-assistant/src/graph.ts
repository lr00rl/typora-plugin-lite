/**
 * GraphStore: locates, loads, and caches `.note-assistant/graph.json`, and owns
 * the rebuild subprocess.
 *
 * Path math always uses the located root (the directory found by walking up
 * from the current file). The graph file's own embedded `root` is whatever
 * machine last generated it — a vault synced across hosts carries a stale
 * absolute path, and trusting it silently breaks every lookup (the old panel's
 * "not indexed" bug). The embedded root is kept only as `graphFileRoot` in the
 * state snapshot for diagnosis.
 */

import { editor, platform } from '@typora-plugin-lite/core'

import { findByBasename, firstNonEmpty, relPathFromRoot, targetCandidates } from './links.js'
import type { GraphFile, GraphNote } from './types.js'

const GRAPH_DIR = '.note-assistant'
const GRAPH_FILE = 'graph.json'
// Vault tools live under `.tools/` after the 2026-08 rename. Keep the old
// `tools/` path as a fallback for vaults that never moved.
const BUILD_SCRIPTS = [
  '.tools/note-assistant/build-graph.mjs',
  'tools/note-assistant/build-graph.mjs',
]
const BUILD_TIMEOUT_MS = 600_000

/** Bumped per deploy so `note-assistant:state` reveals which bundle is live. */
export const BUILD_MARKER = 'palette-2026-09-11a'

export interface CurrentNoteRef {
  currentFile: string
  relPath: string
  note: GraphNote | null
}

export class GraphStore {
  private graphCache: GraphFile | null = null
  private graphMtime = 0
  graphPath = ''
  /** Located root (authoritative for all path math). */
  graphRoot = ''
  /** Root embedded in the file; diagnostic only, never used for path math. */
  graphFileRoot = ''
  noteMap: Map<string, GraphNote> = new Map()
  rebuildInFlight = false

  get generatedAt(): string {
    return this.graphCache?.generatedAt || ''
  }

  get totalNotes(): number {
    return this.graphCache?.notes.length ?? 0
  }

  /** Authoritative vault root for path math: located root first, then fallbacks. */
  rootDir(): string {
    return this.graphRoot || this.getFallbackRootDir()
  }

  private getCurrentSearchRoots(): string[] {
    const win = window as any
    const watched = editor.getWatchedFolder()
    const currentFile = editor.getFilePath()
    const mountFolder = firstNonEmpty(
      watched,
      win.File?.getMountFolder?.(),
      win._options?.mountFolder,
      currentFile ? platform.path.dirname(currentFile) : '',
    )
    return [...new Set([watched, mountFolder, currentFile ? platform.path.dirname(currentFile) : ''].filter((value): value is string => !!value))]
  }

  private getFallbackRootDir(): string {
    return firstNonEmpty(
      editor.getWatchedFolder(),
      this.graphRoot,
      editor.getFilePath() ? platform.path.dirname(editor.getFilePath()) : '',
    )
  }

  private async findUpwardsForFile(relativePath: string): Promise<{ root: string; absPath: string } | null> {
    for (const start of this.getCurrentSearchRoots()) {
      let dir = start
      const seen = new Set<string>()
      while (dir && !seen.has(dir)) {
        seen.add(dir)
        const candidate = platform.path.join(dir, relativePath)
        if (await platform.fs.exists(candidate)) {
          return { root: dir, absPath: candidate }
        }
        const parent = platform.path.dirname(dir)
        if (!parent || parent === dir) break
        dir = parent
      }
    }
    return null
  }

  async load(force = false): Promise<GraphFile | null> {
    const located = await this.findUpwardsForFile(platform.path.join(GRAPH_DIR, GRAPH_FILE))
    if (!located) {
      this.clear()
      return null
    }

    try {
      const stat = await platform.fs.stat(located.absPath)
      const mtime = stat.mtimeMs ?? 0
      if (
        this.graphCache &&
        !force &&
        this.graphPath === located.absPath &&
        this.graphRoot === located.root &&
        this.graphMtime === mtime
      ) {
        return this.graphCache
      }

      const text = await platform.fs.readText(located.absPath)
      const parsed = JSON.parse(text) as GraphFile
      this.graphCache = parsed
      this.graphPath = located.absPath
      this.graphRoot = located.root
      this.graphFileRoot = parsed.root || ''
      this.graphMtime = mtime
      this.noteMap = new Map(parsed.notes.map(note => [note.relPath, note]))
      return parsed
    } catch (err) {
      console.error('[tpl:note-assistant] failed to load graph', err)
      this.clear()
      return null
    }
  }

  private clear(): void {
    this.graphCache = null
    this.graphPath = ''
    this.graphRoot = ''
    this.graphFileRoot = ''
    this.graphMtime = 0
    this.noteMap.clear()
  }

  /** The open document resolved against the graph, or null when nothing is open. */
  currentNote(): CurrentNoteRef | null {
    const currentFile = editor.getFilePath()
    if (!currentFile) return null
    const root = this.graphRoot || this.getFallbackRootDir()
    const relPath = root ? relPathFromRoot(currentFile, root) : currentFile
    return { currentFile, relPath, note: this.noteMap.get(relPath) || null }
  }

  /** True once graph.json has been read at least once. */
  get isLoaded(): boolean {
    return !!this.graphCache
  }

  /**
   * Synchronous, filesystem-free verdict on a wiki target, for decorating many
   * inline links at once. `resolveNoteTarget` is the authority (it stats the
   * disk); this only consults the in-memory graph, so it is cheap enough to run
   * over every link on a page and is allowed to be optimistic: an `unknown`
   * verdict means "not in the last index", not "definitely broken".
   */
  probeNoteTarget(rawTarget: string, currentFile: string): 'known' | 'basename' | 'unknown' {
    if (!this.graphCache) return 'known'
    const root = this.rootDir()
    if (!root) return 'known'
    const { candidates } = targetCandidates(rawTarget, currentFile, root)
    for (const candidate of candidates) {
      if (this.noteMap.has(relPathFromRoot(candidate, root))) return 'known'
    }
    return findByBasename(this.noteMap.keys(), rawTarget).length ? 'basename' : 'unknown'
  }

  /**
   * Resolve a wiki target to an existing file: direct candidates first
   * (current-dir then root-relative), then the moved-note fallback — a unique
   * basename match in the graph, with a same-directory preference on ties.
   * Callers get the full picture (via + match count) so they can explain a
   * healed or unresolvable link instead of failing silently.
   */
  async resolveNoteTarget(rawTarget: string, currentFile: string): Promise<{
    absPath: string | null
    via: 'direct' | 'basename' | null
    basenameMatches: number
  }> {
    const root = this.rootDir()
    const { candidates } = targetCandidates(rawTarget, currentFile, root)
    for (const candidate of candidates) {
      if (await platform.fs.exists(candidate)) {
        return { absPath: candidate, via: 'direct', basenameMatches: 0 }
      }
    }

    const matches = findByBasename(this.noteMap.keys(), rawTarget)
    if (!matches.length || !root) {
      return { absPath: null, via: null, basenameMatches: matches.length }
    }
    if (matches.length > 1) {
      const currentRel = relPathFromRoot(currentFile, root)
      const currentDir = platform.path.dirname(currentRel)
      const sameDir = matches.find(rel => platform.path.dirname(rel) === currentDir)
      if (!sameDir) return { absPath: null, via: null, basenameMatches: matches.length }
      const absPath = platform.path.join(root, sameDir)
      if (!(await platform.fs.exists(absPath))) return { absPath: null, via: null, basenameMatches: matches.length }
      return { absPath, via: 'basename', basenameMatches: matches.length }
    }
    const absPath = platform.path.join(root, matches[0])
    if (!(await platform.fs.exists(absPath))) return { absPath: null, via: null, basenameMatches: 1 }
    return { absPath, via: 'basename', basenameMatches: 1 }
  }

  async rebuild(): Promise<boolean> {
    if (this.rebuildInFlight) return false
    // Flip the flag before the first await: a key-repeat storm must not slip
    // two concurrent builds through the fs.exists walk and tear graph.json.
    this.rebuildInFlight = true
    try {
      let located: { root: string; absPath: string } | null = null
      for (const script of BUILD_SCRIPTS) {
        located = await this.findUpwardsForFile(script)
        if (located) break
      }
      if (!located) return false
      const cmd = `node ${platform.shell.escape(located.absPath)} --root ${platform.shell.escape(located.root)} --allow-heuristic-blocks`
      await platform.shell.run(cmd, { cwd: located.root, timeout: BUILD_TIMEOUT_MS })
      await this.load(true)
      return true
    } catch (err) {
      console.error('[tpl:note-assistant] rebuild failed', err)
      return false
    } finally {
      this.rebuildInFlight = false
    }
  }

  stateSnapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const current = this.currentNote()
    return {
      buildMarker: BUILD_MARKER,
      graphFound: !!this.graphCache,
      graphPath: this.graphPath || null,
      graphRoot: this.graphRoot || null,
      graphFileRoot: this.graphFileRoot || null,
      generatedAt: this.graphCache?.generatedAt || null,
      totalNotes: this.graphCache?.notes.length ?? 0,
      currentFile: current?.currentFile || null,
      currentRelPath: current?.relPath || null,
      currentNoteIndexed: !!current?.note,
      relatedCount: current?.note?.related?.length ?? 0,
      explicitLinkCount: current?.note?.explicitLinks?.length ?? 0,
      backlinkCount: current?.note?.backlinks?.length ?? 0,
      candidateCount: current?.note?.candidates?.length ?? 0,
      rebuildInFlight: this.rebuildInFlight,
      ...extra,
    }
  }
}
