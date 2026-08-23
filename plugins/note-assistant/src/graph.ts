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

import { firstNonEmpty, relPathFromRoot } from './links.js'
import type { GraphFile, GraphNote } from './types.js'

const GRAPH_DIR = '.note-assistant'
const GRAPH_FILE = 'graph.json'
const BUILD_SCRIPT = 'tools/note-assistant/build-graph.mjs'

/** Bumped per deploy so `note-assistant:state` reveals which bundle is live. */
export const BUILD_MARKER = 'palette-2026-08-22a'

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

  async rebuild(): Promise<boolean> {
    if (this.rebuildInFlight) return false
    // Flip the flag before the first await: a key-repeat storm must not slip
    // two concurrent builds through the fs.exists walk and tear graph.json.
    this.rebuildInFlight = true
    try {
      const located = await this.findUpwardsForFile(BUILD_SCRIPT)
      if (!located) return false
      const cmd = `node ${platform.shell.escape(located.absPath)} --root ${platform.shell.escape(located.root)} --allow-heuristic-blocks`
      await platform.shell.run(cmd, { cwd: located.root, timeout: 120_000 })
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
