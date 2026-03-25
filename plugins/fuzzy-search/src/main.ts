import { Plugin, editor, platform } from '@typora-plugin-lite/core'

interface FileEntry {
  absPath: string
  relPath: string
  basename: string
}

interface LibraryIndexStats {
  totalNodes: number
  dirCount: number
  fileCount: number
  fetchedDirCount: number
  unfetchedDirs: string[]
}

const MD_EXTS = ['.md', '.markdown']
const MD_EXT_SET = new Set(MD_EXTS)
const MAX_MRU = 30
const HOTKEY = 'Mod+.'
const DEBOUNCE_MS = 150
const INDEX_TTL_MS = 5_000
const IGNORED_DIRS = ['.git', 'node_modules', '.obsidian', '.trash', '.Trash', '_archive']
const TAG = '[tpl:quick-open]'
const DEBUG_SAMPLE_LIMIT = 20

// ---------------------------------------------------------------------------
// FZF-inspired scoring (ported from fzf.nvim behavior)
// Bonuses: consecutive chars, word boundaries (/ - _ . space), basename prefix,
//          exact prefix match, camelCase transitions
// ---------------------------------------------------------------------------
function fzfScore(text: string, query: string): number {
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

  const span = positions[positions.length - 1] - positions[0] + 1
  score -= span * 0.4
  score -= (t.length - q.length) * 0.1
  return score
}

function scoreFile(f: FileEntry, query: string): number {
  const nameScore = fzfScore(f.basename, query) + 25
  const pathScore = fzfScore(f.relPath, query)
  return Math.max(nameScore, pathScore)
}

// ---------------------------------------------------------------------------
// Relative path helper
// ---------------------------------------------------------------------------
function toRelPath(absPath: string, root: string): string {
  if (!root) return absPath
  // Ensure root ends with separator for safe prefix check
  const prefix = root.endsWith('/') ? root : root + '/'
  if (absPath.startsWith(prefix)) {
    return absPath.slice(prefix.length)
  }
  return absPath
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------
const CSS = `
#tpl-qo-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  z-index: 99998;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
}
#tpl-qo-modal {
  background: var(--bg-color, #fff);
  border-radius: 10px;
  box-shadow: 0 12px 48px rgba(0,0,0,0.35);
  width: 600px;
  max-width: 92vw;
  overflow: hidden;
  border: 1px solid var(--border-color, rgba(128,128,128,0.2));
  display: flex;
  flex-direction: column;
}
#tpl-qo-input-row {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  gap: 10px;
  border-bottom: 1px solid var(--border-color, rgba(128,128,128,0.15));
  flex-shrink: 0;
}
#tpl-qo-icon {
  font-size: 17px;
  opacity: 0.4;
  flex-shrink: 0;
  line-height: 1;
  user-select: none;
}
#tpl-qo-input {
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
  flex: 1;
  font-size: 15px;
  background: transparent;
  color: var(--text-color, inherit);
  font-family: inherit;
  padding: 0;
  margin: 0;
}
#tpl-qo-list {
  overflow-y: auto;
  max-height: 400px;
  padding: 4px 0;
}
.tpl-qo-section-label {
  padding: 4px 16px 2px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.35;
  user-select: none;
}
.tpl-qo-item {
  padding: 6px 16px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tpl-qo-item.tpl-qo-selected {
  background: var(--select-bg, rgba(100,100,255,0.12));
}
.tpl-qo-name {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-color, inherit);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tpl-qo-path {
  font-size: 11.5px;
  opacity: 0.42;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tpl-qo-status {
  padding: 14px 16px;
  font-size: 13px;
  opacity: 0.5;
}
#tpl-qo-footer {
  padding: 5px 16px;
  font-size: 11px;
  opacity: 0.32;
  border-top: 1px solid var(--border-color, rgba(128,128,128,0.12));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  user-select: none;
}
`

export default class QuickOpenPlugin extends Plugin {
  private overlay: HTMLElement | null = null
  private inputEl: HTMLInputElement | null = null
  private listEl: HTMLElement | null = null
  /** All searchable files (MRU + current dir + workspace index) */
  private allFiles: FileEntry[] = []
  private filtered: FileEntry[] = []
  private selectedIdx = 0
  private modalCleanups: Array<() => void> = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private currentQuery = ''

  /** Cached full vault index */
  private vaultIndex: FileEntry[] = []
  private vaultIndexRoot = ''
  private vaultIndexTime = 0
  private indexing = false
  private fzfChecked = false
  private fzfPath: string | null = null

  onload(): void {
    this.log('onload', { hotkey: HOTKEY, dataDir: platform.dataDir })
    this.registerHotkey(HOTKEY, () => this.open())
  }

  onunload(): void {
    this.log('onunload', {
      indexedFiles: this.vaultIndex.length,
      vaultIndexRoot: this.vaultIndexRoot,
      currentQuery: this.currentQuery,
    })
    this.close()
  }

  private log(...args: unknown[]): void {
    console.log(TAG, ...args)
  }

  private warn(...args: unknown[]): void {
    console.warn(TAG, ...args)
  }

  private getDebugDir(): string {
    return platform.path.join(platform.dataDir, 'debug')
  }

  private getDebugStatePath(): string {
    return platform.path.join(this.getDebugDir(), 'fuzzy-search-state.json')
  }

  private getDebugIndexPath(): string {
    return platform.path.join(this.getDebugDir(), 'fuzzy-search-index.json')
  }

  private async persistDebugDump(reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      const debugDir = this.getDebugDir()
      const statePath = this.getDebugStatePath()
      const indexPath = this.getDebugIndexPath()
      await platform.fs.mkdir(debugDir)

      const state = {
        reason,
        timestamp: new Date().toISOString(),
        dataDir: platform.dataDir,
        debugDir,
        rootDir: this.getRootDir(),
        currentDir: this.getCurrentDir(),
        query: this.inputEl?.value ?? this.currentQuery,
        allFilesCount: this.allFiles.length,
        filteredCount: this.filtered.length,
        vaultIndexCount: this.vaultIndex.length,
        vaultIndexRoot: this.vaultIndexRoot,
        vaultIndexTime: this.vaultIndexTime ? new Date(this.vaultIndexTime).toISOString() : null,
        allFilesSample: this.allFiles.slice(0, DEBUG_SAMPLE_LIMIT),
        filteredSample: this.filtered.slice(0, DEBUG_SAMPLE_LIMIT),
        extra,
      }
      const indexDump = {
        reason,
        timestamp: state.timestamp,
        rootDir: this.vaultIndexRoot || this.getRootDir(),
        count: this.vaultIndex.length,
        files: this.vaultIndex.map(file => ({
          absPath: file.absPath,
          relPath: file.relPath,
          basename: file.basename,
        })),
      }

      await Promise.all([
        platform.fs.writeText(statePath, JSON.stringify(state, null, 2) + '\n'),
        platform.fs.writeText(indexPath, JSON.stringify(indexDump, null, 2) + '\n'),
      ])
      this.log('debug dump written', { reason, statePath, indexPath, count: this.vaultIndex.length })
    } catch (err) {
      this.warn('failed to write debug dump', { reason, err })
    }
  }

  private async ensureFzfInfo(): Promise<void> {
    if (this.fzfChecked) return
    this.fzfChecked = true
    try {
      const out = (await platform.shell.run('command -v fzf || which fzf || true', { timeout: 3000 })).trim()
      this.fzfPath = out || null
      this.log('fzf detection', { found: !!this.fzfPath, path: this.fzfPath })
    } catch (err) {
      this.warn('fzf detection failed', err)
    }
  }

  // -------------------------------------------------------------------------
  // MRU helpers
  // -------------------------------------------------------------------------
  private getMru(): string[] {
    const raw = this.settings.get('mru' as never)
    return Array.isArray(raw) ? (raw as string[]) : []
  }

  private async saveMru(mru: string[]): Promise<void> {
    this.settings.set('mru' as never, mru as never)
    await this.settings.save()
  }

  private async recordOpen(absPath: string): Promise<void> {
    const mru = this.getMru().filter(p => p !== absPath)
    mru.unshift(absPath)
    if (mru.length > MAX_MRU) mru.length = MAX_MRU
    await this.saveMru(mru)
  }

  // -------------------------------------------------------------------------
  // Directory helpers
  // -------------------------------------------------------------------------
  private getCurrentDir(): string {
    const filePath = editor.getFilePath()
    return filePath ? platform.path.dirname(filePath) : ''
  }

  private getWorkspaceCandidates(): Record<string, string> {
    const win = window as any
    return {
      fileGetMountFolder: win.File?.getMountFolder?.() ?? '',
      editorWatchedFolder: editor.getWatchedFolder() ?? '',
      optionsMountFolder: win._options?.mountFolder ?? '',
      currentDir: this.getCurrentDir(),
      filePath: editor.getFilePath(),
    }
  }

  private getWorkspaceRoot(): string {
    const candidates = this.getWorkspaceCandidates()
    const mountFolder =
      candidates.fileGetMountFolder
      || candidates.editorWatchedFolder
      || candidates.optionsMountFolder
      || ''
    return typeof mountFolder === 'string' && mountFolder ? mountFolder : ''
  }

  private getRootDir(): string {
    return this.getWorkspaceRoot() || this.getCurrentDir()
  }

  private getLibraryRootEntity(): TyporaFileEntity | null {
    const root = (window as any).File?.editor?.library?.root
    return root && typeof root.path === 'string' ? root as TyporaFileEntity : null
  }

  private flattenTyporaEntityPayload(
    payload: unknown,
    root: string,
    acc: Map<string, FileEntry>,
    stats?: { callbackCount: number; nodeCount: number; dirCount: number; fileCount: number },
    visited = new Set<string>(),
  ): void {
    if (!payload) return

    if (Array.isArray(payload)) {
      for (const item of payload) this.flattenTyporaEntityPayload(item, root, acc, stats, visited)
      return
    }

    if (typeof payload !== 'object') return
    const node = payload as Partial<TyporaFileEntity>
    if (!node.path || typeof node.path !== 'string' || visited.has(node.path)) return
    visited.add(node.path)
    if (stats) stats.nodeCount += 1

    if (node.isDirectory) {
      if (stats) stats.dirCount += 1
      const subdir = Array.isArray(node.subdir) ? node.subdir : []
      const content = Array.isArray(node.content) ? node.content : []
      for (const child of [...subdir, ...content]) {
        this.flattenTyporaEntityPayload(child, root, acc, stats, visited)
      }
      return
    }

    if (!node.isFile) return
    if (stats) stats.fileCount += 1
    const basename = typeof node.name === 'string' && node.name
      ? node.name
      : platform.path.basename(node.path)
    const ext = platform.path.extname(basename).toLowerCase()
    if (!MD_EXT_SET.has(ext)) return
    acc.set(node.path, {
      absPath: node.path,
      relPath: toRelPath(node.path, root),
      basename,
    })
  }

  private inspectLibraryTree(root: string, maxDepth = 20): LibraryIndexStats {
    const rootEntity = this.getLibraryRootEntity()
    const stats: LibraryIndexStats = {
      totalNodes: 0,
      dirCount: 0,
      fileCount: 0,
      fetchedDirCount: 0,
      unfetchedDirs: [],
    }
    if (!rootEntity) return stats

    const visited = new Set<string>()
    const walk = (node: TyporaFileEntity, depth: number): void => {
      if (!node?.path || visited.has(node.path) || depth > maxDepth) return
      visited.add(node.path)
      stats.totalNodes += 1

      if (node.isDirectory) {
        stats.dirCount += 1
        if (node.fetched) {
          stats.fetchedDirCount += 1
        } else {
          stats.unfetchedDirs.push(toRelPath(node.path, root))
        }
        const children = [...(node.subdir ?? []), ...(node.content ?? [])]
        for (const child of children) walk(child, depth + 1)
        return
      }

      if (node.isFile) stats.fileCount += 1
    }

    walk(rootEntity, 0)
    return stats
  }

  private collectVaultIndexFromLibrary(root: string, maxDepth = 20, maxFiles = 5000): FileEntry[] {
    const rootEntity = this.getLibraryRootEntity()
    if (!rootEntity) {
      this.log('libraryIndex:no-root-entity')
      return []
    }

    const visited = new Set<string>()
    const files: FileEntry[] = []
    const stats = this.inspectLibraryTree(root, maxDepth)
    const walk = (node: TyporaFileEntity, depth: number): void => {
      if (!node?.path || visited.has(node.path) || files.length >= maxFiles || depth > maxDepth) return
      visited.add(node.path)

      if (node.isDirectory) {
        if (IGNORED_DIRS.includes(node.name) || node.name.startsWith('.')) return
        const children = [...(node.subdir ?? []), ...(node.content ?? [])]
        for (const child of children) {
          if (files.length >= maxFiles) break
          walk(child, depth + 1)
        }
        return
      }

      if (!node.isFile) return
      const ext = platform.path.extname(node.name || node.path).toLowerCase()
      if (!MD_EXT_SET.has(ext)) return
      files.push({
        absPath: node.path,
        relPath: toRelPath(node.path, root),
        basename: node.name || platform.path.basename(node.path),
      })
    }

    this.log('libraryIndex:start', {
      root,
      entityPath: rootEntity.path,
      entityName: rootEntity.name,
      fetched: rootEntity.fetched ?? null,
      subdirCount: rootEntity.subdir?.length ?? 0,
      contentCount: rootEntity.content?.length ?? 0,
      maxDepth,
      maxFiles,
      treeStats: {
        totalNodes: stats.totalNodes,
        dirCount: stats.dirCount,
        fileCount: stats.fileCount,
        fetchedDirCount: stats.fetchedDirCount,
        unfetchedDirCount: stats.unfetchedDirs.length,
        unfetchedDirsSample: stats.unfetchedDirs.slice(0, DEBUG_SAMPLE_LIMIT),
      },
    })
    walk(rootEntity, 0)
    this.log('libraryIndex:done', {
      root,
      count: files.length,
      sample: files.slice(0, DEBUG_SAMPLE_LIMIT).map(file => file.relPath),
      treeStats: {
        totalNodes: stats.totalNodes,
        dirCount: stats.dirCount,
        fileCount: stats.fileCount,
        fetchedDirCount: stats.fetchedDirCount,
        unfetchedDirCount: stats.unfetchedDirs.length,
      },
    })
    return files
  }

  private collectVaultIndexFromBridge(root: string, maxFiles = 5000, hardTimeoutMs = 5000): Promise<FileEntry[]> {
    return new Promise(resolve => {
      const bridge = window.bridge
      if (!bridge?.callHandler) {
        this.log('bridgeIndex:unavailable')
        resolve([])
        return
      }

      const entries = new Map<string, FileEntry>()
      const stats = { callbackCount: 0, nodeCount: 0, dirCount: 0, fileCount: 0 }
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let hardTimer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const finish = (reason: string): void => {
        if (settled) return
        settled = true
        if (idleTimer) clearTimeout(idleTimer)
        if (hardTimer) clearTimeout(hardTimer)
        const files = [...entries.values()].slice(0, maxFiles)
        this.log('bridgeIndex:done', {
          root,
          reason,
          callbackCount: stats.callbackCount,
          nodeCount: stats.nodeCount,
          dirCount: stats.dirCount,
          fileCount: stats.fileCount,
          count: files.length,
          sample: files.slice(0, DEBUG_SAMPLE_LIMIT).map(file => file.relPath),
        })
        resolve(files)
      }
      const bumpIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => finish('idle-timeout'), 250)
      }

      this.log('bridgeIndex:start', { root, hardTimeoutMs, maxFiles })
      try {
        bridge.callHandler('library.fetchAllDocs', root)
        this.log('bridgeIndex:fetchAllDocs-dispatched', { root })
      } catch (err) {
        this.warn('bridgeIndex:fetchAllDocs-failed', { root, err })
      }

      hardTimer = setTimeout(() => finish('hard-timeout'), hardTimeoutMs)

      try {
        bridge.callHandler('library.listDocsUnder', root, (payload: unknown) => {
          stats.callbackCount += 1
          this.log('bridgeIndex:callback', {
            root,
            callbackCount: stats.callbackCount,
            payloadType: Array.isArray(payload) ? 'array' : typeof payload,
            path: (payload as any)?.path ?? null,
            name: (payload as any)?.name ?? null,
            fetched: (payload as any)?.fetched ?? null,
            subdirCount: Array.isArray((payload as any)?.subdir) ? (payload as any).subdir.length : null,
            contentCount: Array.isArray((payload as any)?.content) ? (payload as any).content.length : null,
          })
          this.flattenTyporaEntityPayload(payload, root, entries, stats)
          if (entries.size >= maxFiles) {
            finish('max-files')
            return
          }
          bumpIdleTimer()
        })
      } catch (err) {
        this.warn('bridgeIndex:failed', { root, err })
        finish('bridge-error')
      }
    })
  }

  /**
   * Reliable directory walker that doesn't depend on Typora's library tree.
   * Strategy: try `find` first (fast, single command), fall back to BFS `ls -p`.
   */
  private async walkDirPure(root: string, maxDepth = 20, maxFiles = 5000): Promise<FileEntry[]> {
    // Fast path: single `find` command (typically <100ms for most workspaces)
    try {
      const findResult = await this.walkDirWithFind(root, maxDepth, maxFiles)
      if (findResult.length > 0) return findResult
    } catch (err) {
      this.log('walkDirPure:find-failed, falling back to BFS', { root, err })
    }

    // Fallback: BFS with `ls -p` per directory (reliable, many small calls)
    return this.walkDirWithBFS(root, maxDepth, maxFiles)
  }

  private async walkDirWithFind(root: string, maxDepth: number, maxFiles: number): Promise<FileEntry[]> {
    const esc = (s: string) => platform.shell.escape(s)
    const ignorePrune = IGNORED_DIRS.map(d => `-name ${esc(d)}`).join(' -o ')
    const extMatch = MD_EXTS.map(e => `-name ${esc('*' + e)}`).join(' -o ')
    const cmd = [
      'find', esc(root),
      `-maxdepth ${maxDepth}`,
      `\\( -type d \\( ${ignorePrune} -o -name '.*' \\) -prune \\)`,
      `-o -type f \\( ${extMatch} \\) -print`,
      `| head -n ${maxFiles}`,
    ].join(' ')

    this.log('walkDirWithFind:start', { root, cmd: cmd.slice(0, 200) })
    const output = await platform.shell.run(cmd, { timeout: 10_000 })
    const results = output.trim().split('\n').filter(Boolean).map(absPath => ({
      absPath,
      relPath: toRelPath(absPath, root),
      basename: platform.path.basename(absPath),
    }))
    this.log('walkDirWithFind:done', { root, count: results.length })
    return results
  }

  private async walkDirWithBFS(root: string, maxDepth: number, maxFiles: number): Promise<FileEntry[]> {
    const results: FileEntry[] = []
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
    const BATCH_SIZE = 16

    while (queue.length > 0 && results.length < maxFiles) {
      const batch = queue.splice(0, BATCH_SIZE)
      const batchResults = await Promise.all(
        batch.map(async ({ dir, depth }) => {
          const files: FileEntry[] = []
          const subdirs: Array<{ dir: string; depth: number }> = []
          try {
            const output = await platform.shell.run(
              `ls -p ${platform.shell.escape(dir)}`,
              { timeout: 5000 },
            )
            for (const entry of output.trim().split('\n').filter(Boolean)) {
              if (entry.startsWith('.')) continue
              if (entry.endsWith('/')) {
                const name = entry.slice(0, -1)
                if (!IGNORED_DIRS.includes(name) && depth + 1 <= maxDepth) {
                  subdirs.push({ dir: platform.path.join(dir, name), depth: depth + 1 })
                }
              } else {
                const ext = platform.path.extname(entry).toLowerCase()
                if (MD_EXT_SET.has(ext)) {
                  const absPath = platform.path.join(dir, entry)
                  files.push({ absPath, relPath: toRelPath(absPath, root), basename: entry })
                }
              }
            }
          } catch { /* directory not listable, skip */ }
          return { files, subdirs }
        }),
      )

      for (const r of batchResults) {
        results.push(...r.files)
        queue.push(...r.subdirs)
      }
    }

    this.log('walkDirWithBFS:done', { root, count: results.length })
    return results.slice(0, maxFiles)
  }

  private mergeFileEntries(primary: FileEntry[], secondary: FileEntry[]): FileEntry[] {
    const merged = new Map<string, FileEntry>()
    for (const entry of [...primary, ...secondary]) merged.set(entry.absPath, entry)
    return [...merged.values()]
  }

  private setFooter(fileCount: number, root: string, status = ''): void {
    const parts = [`${fileCount} 个文件`, root || '(无)']
    if (status) parts.push(status)
    this.updateFooter(parts.join('  ·  '))
  }

  // -------------------------------------------------------------------------
  // File index: two-phase loading
  //   Phase 1 (instant): MRU + current dir siblings → show immediately
  //   Phase 2 (async):   walkDir entire vault → merge in background
  // -------------------------------------------------------------------------
  private async loadFiles(): Promise<void> {
    const root = this.getRootDir()
    const currentDir = this.getCurrentDir()
    const candidates = this.getWorkspaceCandidates()
    const seen = new Set<string>()
    const quickFiles: FileEntry[] = []
    this.log('loadFiles:start', { root, currentDir, candidates, cacheRoot: this.vaultIndexRoot, cacheCount: this.vaultIndex.length })
    await this.ensureFzfInfo()

    // Phase 1a: MRU entries — filter out deleted files
    let mru = this.getMru()
    this.log('loadFiles:mru', { count: mru.length, sample: mru.slice(0, DEBUG_SAMPLE_LIMIT) })
    if (mru.length > 0) {
      try {
        const checkCmd = mru
          .map(p => `test -f ${platform.shell.escape(p)} && printf '%s\\n' ${platform.shell.escape(p)}`)
          .join('; ')
        const output = await platform.shell.run(checkCmd, { timeout: 5000 })
        const existingSet = new Set(output.trim().split('\n').filter(Boolean))
        const before = mru.length
        mru = mru.filter(p => existingSet.has(p))
        if (mru.length < before) {
          this.log('loadFiles:mru-pruned', { before, after: mru.length })
          this.saveMru(mru).catch(() => {})
        }
      } catch (err) {
        this.warn('loadFiles:mru-existence-check-failed', err)
      }
    }
    for (const absPath of mru) {
      if (seen.has(absPath)) continue
      seen.add(absPath)
      quickFiles.push({
        absPath,
        relPath: toRelPath(absPath, root),
        basename: platform.path.basename(absPath),
      })
    }

    // Phase 1b: Sibling .md files in current directory
    if (currentDir) {
      try {
        const entries = await platform.fs.list(currentDir)
        this.log('loadFiles:currentDirList', { currentDir, count: entries.length, sample: entries.slice(0, DEBUG_SAMPLE_LIMIT) })
        for (const name of entries) {
          if (name.startsWith('.')) continue
          const ext = platform.path.extname(name).toLowerCase()
          if (!MD_EXT_SET.has(ext)) continue
          const absPath = platform.path.join(currentDir, name)
          if (seen.has(absPath)) continue
          seen.add(absPath)
          quickFiles.push({
            absPath,
            relPath: toRelPath(absPath, root),
            basename: name,
          })
        }
      } catch (err) {
        this.warn('failed to list current dir', { currentDir, err })
      }
    }

    this.allFiles = quickFiles
    this.log('loadFiles:phase1-complete', {
      root,
      currentDir,
      quickFileCount: quickFiles.length,
      quickFilesSample: quickFiles.slice(0, DEBUG_SAMPLE_LIMIT).map(f => f.relPath),
    })
    this.setFooter(quickFiles.length, root || currentDir, root ? '正在索引整个文件夹…' : '')
    await this.persistDebugDump('phase1-loaded', {
      root,
      currentDir,
      quickFileCount: quickFiles.length,
      quickFilesSample: quickFiles.slice(0, DEBUG_SAMPLE_LIMIT).map(f => f.relPath),
      candidates,
      fzfPath: this.fzfPath,
    })

    // Phase 2: async vault-wide scan
    if (root) {
      this.log('loadFiles:phase2-dispatch', { root, alreadySeen: seen.size })
      this.loadVaultIndex(root, seen)
    } else {
      this.warn('loadFiles:no-root', { currentDir, candidates })
    }
  }

  private async loadVaultIndex(root: string, alreadySeen: Set<string>): Promise<void> {
    // Use cache if still valid
    if (
      this.vaultIndex.length > 0 &&
      this.vaultIndexRoot === root &&
      Date.now() - this.vaultIndexTime < INDEX_TTL_MS
    ) {
      this.log('loadVaultIndex:cache-hit', {
        root,
        ageMs: Date.now() - this.vaultIndexTime,
        count: this.vaultIndex.length,
      })
      this.mergeVaultIndex(alreadySeen)
      return
    }

    if (this.indexing) {
      this.log('loadVaultIndex:skip-already-indexing', { root, currentRoot: this.vaultIndexRoot })
      return
    }
    this.indexing = true
    const startedAt = Date.now()
    this.setFooter(this.allFiles.length, root, '正在索引整个文件夹…')
    this.log('loadVaultIndex:start', {
      root,
      ignoredDirs: IGNORED_DIRS,
      maxDepth: 20,
      maxFiles: 5000,
    })

    try {
      // Always run pure-JS walk as the primary source (reliable, no timeout)
      // Typora's library tree is lazily loaded and often incomplete
      const [pureWalkEntries, libraryEntries, bridgeEntries] = await Promise.all([
        this.walkDirPure(root, 20, 5000),
        Promise.resolve(this.collectVaultIndexFromLibrary(root, 20, 5000)),
        this.collectVaultIndexFromBridge(root, 5000),
      ])
      // Merge all sources: pure walk is most complete, Typora sources fill gaps
      const allEntries = this.mergeFileEntries(
        pureWalkEntries,
        this.mergeFileEntries(libraryEntries, bridgeEntries),
      )
      this.log('loadVaultIndex:sources', {
        root,
        pureWalkCount: pureWalkEntries.length,
        libraryCount: libraryEntries.length,
        bridgeCount: bridgeEntries.length,
        mergedCount: allEntries.length,
      })
      this.vaultIndex = allEntries

      this.vaultIndexRoot = root
      this.vaultIndexTime = Date.now()
      this.log('loadVaultIndex:done', {
        root,
        durationMs: Date.now() - startedAt,
        count: this.vaultIndex.length,
        sample: this.vaultIndex.slice(0, DEBUG_SAMPLE_LIMIT).map(f => f.relPath),
      })
      await this.persistDebugDump('vault-indexed', {
        root,
        durationMs: Date.now() - startedAt,
        count: this.vaultIndex.length,
      })

      this.mergeVaultIndex(alreadySeen)
    } catch (err) {
      this.warn('vault index failed', { root, err })
      await this.persistDebugDump('vault-index-failed', {
        root,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.indexing = false
    }
  }

  private mergeVaultIndex(alreadySeen: Set<string>): void {
    const newEntries: FileEntry[] = []
    for (const entry of this.vaultIndex) {
      if (!alreadySeen.has(entry.absPath)) {
        alreadySeen.add(entry.absPath)
        newEntries.push(entry)
      }
    }
    if (newEntries.length > 0) {
      this.allFiles = [...this.allFiles, ...newEntries]
    }

    const root = this.getRootDir()
    this.log('mergeVaultIndex', {
      root,
      newEntries: newEntries.length,
      totalFiles: this.allFiles.length,
      sample: newEntries.slice(0, DEBUG_SAMPLE_LIMIT).map(f => f.relPath),
    })
    this.setFooter(this.allFiles.length, root, '')
    void this.persistDebugDump('vault-index-merged', {
      root,
      newEntries: newEntries.length,
      totalFiles: this.allFiles.length,
    })

    if (this.overlay) {
      this.renderList(this.inputEl?.value ?? this.currentQuery)
    }
  }

  // -------------------------------------------------------------------------
  // Modal open / close
  // -------------------------------------------------------------------------
  private async open(): Promise<void> {
    if (this.overlay) {
      this.log('open:overlay-exists-toggle-close')
      this.close()
      return
    }
    this.log('open:start', {
      filePath: editor.getFilePath(),
      fileName: editor.getFileName(),
      watchedFolder: editor.getWatchedFolder(),
    })
    this.buildModal()
    await this.loadFiles()
    if (this.overlay) {
      this.renderList('')
    }
  }

  private close(): void {
    this.log('close', {
      currentQuery: this.currentQuery,
      filteredCount: this.filtered.length,
      allFilesCount: this.allFiles.length,
    })
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    for (const fn of this.modalCleanups) fn()
    this.modalCleanups = []
    this.overlay?.remove()
    this.overlay = null
    this.inputEl = null
    this.listEl = null
    this.filtered = []
    this.selectedIdx = 0
    this.currentQuery = ''
  }

  // -------------------------------------------------------------------------
  // Build DOM
  // -------------------------------------------------------------------------
  private buildModal(): void {
    this.log('buildModal')
    if (!document.getElementById('tpl-qo-style')) {
      const style = document.createElement('style')
      style.id = 'tpl-qo-style'
      style.textContent = CSS
      document.head.appendChild(style)
      this.addDisposable(() => style.remove())
    }

    const overlay = document.createElement('div')
    overlay.id = 'tpl-qo-overlay'
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this.close()
    })

    const modal = document.createElement('div')
    modal.id = 'tpl-qo-modal'

    const inputRow = document.createElement('div')
    inputRow.id = 'tpl-qo-input-row'
    const icon = document.createElement('span')
    icon.id = 'tpl-qo-icon'
    icon.textContent = '\u2315'
    const input = document.createElement('input')
    input.id = 'tpl-qo-input'
    input.type = 'text'
    input.placeholder = '搜索整个文件夹中的 Markdown 文件...'
    input.autocomplete = 'off'
    input.spellcheck = false
    inputRow.appendChild(icon)
    inputRow.appendChild(input)

    const list = document.createElement('div')
    list.id = 'tpl-qo-list'

    const footer = document.createElement('div')
    footer.id = 'tpl-qo-footer'
    footer.textContent = '加载中...'

    modal.appendChild(inputRow)
    modal.appendChild(list)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    this.overlay = overlay
    this.inputEl = input
    this.listEl = list

    const onInput = () => {
      this.log('input', { value: input.value, length: input.value.length, indexedFiles: this.allFiles.length })
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => this.renderList(input.value), DEBOUNCE_MS)
    }
    const onKeydown = (e: KeyboardEvent) => this.handleKey(e)
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close() }
    }
    input.addEventListener('input', onInput)
    input.addEventListener('keydown', onKeydown)
    document.addEventListener('keydown', onEsc, { capture: true })
    this.modalCleanups.push(
      () => input.removeEventListener('input', onInput),
      () => input.removeEventListener('keydown', onKeydown),
      () => document.removeEventListener('keydown', onEsc, { capture: true }),
    )

    this.renderList('')
    setTimeout(() => input.focus(), 30)
  }

  private updateFooter(text: string): void {
    const el = this.overlay?.querySelector('#tpl-qo-footer')
    if (el) el.textContent = text
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  private renderList(query: string): void {
    const list = this.listEl
    if (!list) return
    this.currentQuery = query
    list.innerHTML = ''

    if (!this.allFiles.length) {
      list.appendChild(this.makeStatus('未找到 Markdown 文件'))
      return
    }

    if (query.trim()) {
      // --- Query mode: FZF scoring across all vault files ---
      const results = this.allFiles
        .map(f => ({ f, s: scoreFile(f, query) }))
        .filter(x => x.s > -Infinity)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
      this.filtered = results.map(x => x.f)
      this.log('renderList:query', {
        query,
        indexedFiles: this.allFiles.length,
        resultCount: this.filtered.length,
        topResults: this.filtered.slice(0, 10).map(f => f.relPath),
        fzfPath: this.fzfPath,
      })
      void this.persistDebugDump('render-query', {
        query,
        resultCount: this.filtered.length,
        topResults: this.filtered.slice(0, 10).map(f => f.relPath),
      })

      if (!this.filtered.length) {
        list.appendChild(this.makeStatus('没有匹配的文件'))
        return
      }
      this.selectedIdx = 0
      this.filtered.forEach((f, i) => list.appendChild(this.makeItem(f, i)))
    } else {
      // --- Default view: MRU first, then current dir siblings ---
      const mru = this.getMru()
      const mruSet = new Set(mru)
      const fileMap = new Map(this.allFiles.map(f => [f.absPath, f]))

      const mruFiles = mru
        .map(p => fileMap.get(p))
        .filter((f): f is FileEntry => !!f)
        .slice(0, 15)

      const currentDir = this.getCurrentDir()
      const root = this.getRootDir()
      const currentDirPrefix = currentDir ? (currentDir.endsWith('/') ? currentDir : currentDir + '/') : ''

      const siblingFiles = this.allFiles
        .filter(f =>
          !mruSet.has(f.absPath) &&
          currentDirPrefix &&
          f.absPath.startsWith(currentDirPrefix) &&
          !f.absPath.slice(currentDirPrefix.length).includes('/'),
        )
        .slice(0, 20)

      // Other vault files (not MRU, not siblings)
      const shownSet = new Set([
        ...mruFiles.map(f => f.absPath),
        ...siblingFiles.map(f => f.absPath),
      ])
      const otherFiles = this.allFiles
        .filter(f => !shownSet.has(f.absPath))
        .slice(0, 15)

      this.filtered = [...mruFiles, ...siblingFiles, ...otherFiles]
      this.log('renderList:default', {
        indexedFiles: this.allFiles.length,
        mruCount: mruFiles.length,
        siblingCount: siblingFiles.length,
        otherCount: otherFiles.length,
      })
      void this.persistDebugDump('render-default', {
        mruCount: mruFiles.length,
        siblingCount: siblingFiles.length,
        otherCount: otherFiles.length,
      })
      this.selectedIdx = 0

      let idx = 0
      if (mruFiles.length) {
        list.appendChild(this.makeSectionLabel('最近打开'))
        mruFiles.forEach(f => list.appendChild(this.makeItem(f, idx++)))
      }
      if (siblingFiles.length) {
        list.appendChild(this.makeSectionLabel('当前目录'))
        siblingFiles.forEach(f => list.appendChild(this.makeItem(f, idx++)))
      }
      if (otherFiles.length) {
        list.appendChild(this.makeSectionLabel('其他文件'))
        otherFiles.forEach(f => list.appendChild(this.makeItem(f, idx++)))
      }
    }
  }

  private makeItem(f: FileEntry, idx: number): HTMLElement {
    const item = document.createElement('div')
    item.className = 'tpl-qo-item' + (idx === this.selectedIdx ? ' tpl-qo-selected' : '')

    const name = document.createElement('div')
    name.className = 'tpl-qo-name'
    name.textContent = f.basename

    const pathEl = document.createElement('div')
    pathEl.className = 'tpl-qo-path'
    // Show parent directory path (without filename) for clearer context
    const lastSlash = f.relPath.lastIndexOf('/')
    pathEl.textContent = lastSlash > 0 ? f.relPath.slice(0, lastSlash) : '/'

    item.appendChild(name)
    item.appendChild(pathEl)
    item.addEventListener('mouseenter', () => { this.selectedIdx = idx; this.highlight() })
    item.addEventListener('click', () => this.openSelected())
    return item
  }

  private makeSectionLabel(text: string): HTMLElement {
    const div = document.createElement('div')
    div.className = 'tpl-qo-section-label'
    div.textContent = text
    return div
  }

  private makeStatus(msg: string): HTMLElement {
    const div = document.createElement('div')
    div.className = 'tpl-qo-status'
    div.textContent = msg
    return div
  }

  private highlight(): void {
    const list = this.listEl
    if (!list) return
    list.querySelectorAll('.tpl-qo-item').forEach((el, i) => {
      el.classList.toggle('tpl-qo-selected', i === this.selectedIdx)
    })
    list.querySelectorAll('.tpl-qo-item')[this.selectedIdx]?.scrollIntoView({ block: 'nearest' })
  }

  // -------------------------------------------------------------------------
  // Keyboard navigation
  // -------------------------------------------------------------------------
  private handleKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      this.selectedIdx = Math.min(this.selectedIdx + 1, this.filtered.length - 1)
      this.highlight()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      this.selectedIdx = Math.max(this.selectedIdx - 1, 0)
      this.highlight()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      this.openSelected()
    }
  }

  private openSelected(): void {
    const f = this.filtered[this.selectedIdx]
    if (!f) return
    this.log('openSelected', { index: this.selectedIdx, file: f })
    this.close()
    this.recordOpen(f.absPath).catch(() => {})
    editor.openFile(f.absPath).catch(err => {
      this.warn('openSelected failed', { file: f.absPath, err })
      this.showNotice(`打开文件失败: ${err.message}`)
    })
  }
}
