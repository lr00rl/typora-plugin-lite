import { IS_MAC, Plugin, editor, platform } from '@typora-plugin-lite/core'

interface FileEntry {
  absPath: string
  relPath: string
  cwdRelPath: string
  basename: string
  relPathKey: string
  cwdRelPathKey: string
  basenameKey: string
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
const DEFAULT_HOTKEYS = ['Mod+.', "Mod+'"]
const DEBOUNCE_MS = 80
const INDEX_TTL_MS = 5_000
const SEARCH_RESULT_LIMIT = 50
const EXTERNAL_FZF_THRESHOLD = 50_000
const IGNORED_DIRS = ['.git', 'node_modules', '.obsidian', '.trash', '.Trash', '_archive']
const TAG = '[tpl:quick-open]'
const DEBUG_SAMPLE_LIMIT = 20
const DEBUG = false

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

function fuzzyMatchPositions(text: string, query: string): number[] | null {
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

function scoreFile(f: FileEntry, query: string): number {
  const nameScore = fzfScore(f.basenameKey, query) + 25
  const rootPathScore = fzfScore(f.relPathKey, query) + 8
  const cwdPathScore = fzfScore(f.cwdRelPathKey, query) + (isRelativePathQuery(query) ? 20 : 14)
  return Math.max(nameScore, rootPathScore, cwdPathScore)
}

// ---------------------------------------------------------------------------
// Relative path helper
// ---------------------------------------------------------------------------
function toRelPath(absPath: string, root: string): string {
  if (!root) return absPath
  // Normalize separators for cross-platform matching
  const normAbs = normalizePath(absPath)
  const normRoot = normalizePath(root)
  const prefix = normRoot.endsWith('/') ? normRoot : normRoot + '/'
  if (normAbs.startsWith(prefix)) {
    return normAbs.slice(prefix.length)
  }
  return normAbs
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function splitPath(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean)
}

function getPathRoot(path: string): string {
  const normalized = normalizePath(path)
  const driveMatch = normalized.match(/^[A-Za-z]:/)
  if (driveMatch) return driveMatch[0].toLowerCase()
  return normalized.startsWith('/') ? '/' : ''
}

function toRelPathFromDir(absPath: string, baseDir: string): string {
  const normalizedAbs = normalizePath(absPath)
  const normalizedBase = normalizePath(baseDir)
  if (!normalizedBase) return normalizedAbs
  if (getPathRoot(normalizedAbs) !== getPathRoot(normalizedBase)) return normalizedAbs

  const targetParts = splitPath(normalizedAbs)
  const baseParts = splitPath(normalizedBase)
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

function isRelativePathQuery(query: string): boolean {
  const trimmed = query.trim()
  return (
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  )
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
.tpl-qo-hit {
  color: inherit;
  background: rgba(255, 212, 59, 0.28);
  border-radius: 3px;
  box-shadow: inset 0 -1px 0 rgba(255, 179, 0, 0.22);
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
  private renderToken = 0

  /** Cached full vault index */
  private vaultIndex: FileEntry[] = []
  private vaultIndexRoot = ''
  private vaultIndexTime = 0
  private indexing = false
  private rgChecked = false
  private rgPath: string | null = null
  private fzfChecked = false
  private fzfPath: string | null = null
  private indexBackend = 'walk'
  private searchBackend = 'js'
  private fzfInputPath = ''
  private fzfInputDirty = true
  private fzfInputMap = new Map<string, FileEntry>()
  private openingSelection = false
  private lastHandledEnterAt = 0
  private searchPool: FileEntry[] = []
  private lastSearchQuery = ''
  private searchCacheVersion = 0
  private searchPoolVersion = -1

  private getHotkeys(): string[] {
    const custom = this.settings.get('hotkeys' as never) as unknown
    if (Array.isArray(custom) && custom.length > 0 && custom.every(k => typeof k === 'string')) {
      return custom as string[]
    }
    return DEFAULT_HOTKEYS
  }

  onload(): void {
    const hotkeys = this.getHotkeys()
    this.log('onload', { hotkeys, dataDir: platform.dataDir })
    for (const key of hotkeys) {
      this.registerHotkey(key, () => this.open())
    }
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
    if (DEBUG) console.log(TAG, ...args)
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

  private async writeLargeText(filepath: string, text: string, chunkSize = 24_000): Promise<void> {
    if (text.length <= chunkSize) {
      await platform.fs.writeText(filepath, text)
      return
    }

    await platform.fs.writeText(filepath, '')
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      await platform.fs.appendText(filepath, text.slice(offset, offset + chunkSize))
    }
  }

  private async persistDebugDump(reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!DEBUG) return
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
          cwdRelPath: file.cwdRelPath,
          basename: file.basename,
        })),
      }

      await Promise.all([
        this.writeLargeText(statePath, JSON.stringify(state, null, 2) + '\n'),
        this.writeLargeText(indexPath, JSON.stringify(indexDump, null, 2) + '\n'),
      ])
      this.log('debug dump written', { reason, statePath, indexPath, count: this.vaultIndex.length })
    } catch (err) {
      this.warn('failed to write debug dump', { reason, err })
    }
  }

  private getRuntimePlatform(): 'macos' | 'linux' | 'windows' {
    if (IS_MAC) return 'macos'
    const processPlatform = (window as any).process?.platform
    if (processPlatform === 'win32') return 'windows'
    return 'linux'
  }

  private getExecutableName(name: 'fzf' | 'rg'): string {
    return this.getRuntimePlatform() === 'windows' ? `${name}.exe` : name
  }

  private getBundledBinaryCandidates(name: 'fzf' | 'rg'): string[] {
    const exe = this.getExecutableName(name)
    const platformName = this.getRuntimePlatform()
    const roots = [platform.pluginsDir, platform.builtinPluginsDir].filter(Boolean)
    const candidates: string[] = []

    for (const root of roots) {
      candidates.push(
        platform.path.join(root, 'fuzzy-search', 'bin', exe),
        platform.path.join(root, 'fuzzy-search', 'bin', platformName, exe),
      )
    }

    return [...new Set(candidates)]
  }

  private getBinaryPathDetectCommand(name: 'fzf' | 'rg'): string {
    if (this.getRuntimePlatform() === 'windows') {
      const exe = this.getExecutableName(name)
      return `where ${exe} 2>NUL`
    }
    return `command -v ${name} || which ${name} || true`
  }

  private getCommonBinaryCandidates(name: 'fzf' | 'rg'): string[] {
    const exe = this.getExecutableName(name)
    const platformName = this.getRuntimePlatform()
    if (platformName === 'macos') {
      return [
        `/opt/homebrew/bin/${exe}`,
        `/usr/local/bin/${exe}`,
        `/opt/local/bin/${exe}`,
      ]
    }
    if (platformName === 'linux') {
      return [
        `/usr/local/bin/${exe}`,
        `/usr/bin/${exe}`,
      ]
    }
    return []
  }

  private async resolveBinary(name: 'fzf' | 'rg'): Promise<string | null> {
    try {
      const out = (await platform.shell.run(this.getBinaryPathDetectCommand(name), { timeout: 3000 })).trim()
      const path = out.split(/\r?\n/).find(Boolean)?.trim() ?? ''
      if (path) {
        this.log(`${name} detection`, { found: true, source: 'PATH', path })
        return path
      }
    } catch (err) {
      this.warn(`${name} PATH detection failed`, err)
    }

    for (const candidate of [...this.getBundledBinaryCandidates(name), ...this.getCommonBinaryCandidates(name)]) {
      try {
        if (await platform.fs.exists(candidate)) {
          this.log(`${name} detection`, { found: true, source: 'fallback', path: candidate })
          return candidate
        }
      } catch {}
    }

    this.log(`${name} detection`, { found: false })
    return null
  }

  private async ensureToolInfo(): Promise<void> {
    if (!this.rgChecked) {
      this.rgChecked = true
      this.rgPath = await this.resolveBinary('rg')
      this.indexBackend = this.rgPath ? 'rg' : 'walk'
    }
    if (!this.fzfChecked) {
      this.fzfChecked = true
      this.fzfPath = await this.resolveBinary('fzf')
      this.searchBackend = 'js'
    }
  }

  private invalidateSearchCache(): void {
    this.searchCacheVersion += 1
    this.searchPoolVersion = -1
    this.lastSearchQuery = ''
    this.searchPool = []
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

  private makeFileEntry(
    absPath: string,
    root: string,
    currentDir = this.getCurrentDir(),
    basename = platform.path.basename(absPath),
  ): FileEntry {
    const relPath = toRelPath(absPath, root)
    const cwdRelPath = toRelPathFromDir(absPath, currentDir)
    return {
      absPath,
      relPath,
      cwdRelPath,
      basename,
      relPathKey: relPath.toLowerCase(),
      cwdRelPathKey: cwdRelPath.toLowerCase(),
      basenameKey: basename.toLowerCase(),
    }
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
    acc.set(node.path, this.makeFileEntry(node.path, root, this.getCurrentDir(), basename))
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
      files.push(this.makeFileEntry(node.path, root, this.getCurrentDir(), node.name || platform.path.basename(node.path)))
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
   * Strategy: try platform fs walk first, then `find`, then BFS `ls -p`.
   */
  private async walkDirPure(root: string, maxDepth = 20, maxFiles = 5000): Promise<FileEntry[]> {
    try {
      const currentDir = this.getCurrentDir()
      const walked = await platform.fs.walkDir(root, {
        exts: MD_EXTS,
        ignore: IGNORED_DIRS,
        maxDepth,
        maxFiles,
      })
      const results = walked.map(absPath => this.makeFileEntry(absPath, root, currentDir))
      if (results.length > 0) {
        this.log('walkDirPure:platformFs-hit', { root, count: results.length })
        return results
      }
    } catch (err) {
      this.log('walkDirPure:platformFs-failed, falling back to find', { root, err })
    }

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
    const currentDir = this.getCurrentDir()
    const results = output.trim().split('\n').filter(Boolean)
      .map(absPath => this.makeFileEntry(absPath, root, currentDir))
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
                  files.push(this.makeFileEntry(absPath, root, this.getCurrentDir(), entry))
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

  private async collectVaultIndexWithRg(root: string, maxFiles: number): Promise<FileEntry[]> {
    if (!this.rgPath) return []

    const currentDir = this.getCurrentDir()
    const cmd = [
      platform.shell.escape(this.rgPath),
      '--files',
      ...MD_EXTS.flatMap(ext => ['-g', platform.shell.escape(`*${ext}`)]),
      ...IGNORED_DIRS.flatMap(name => ['-g', platform.shell.escape(`!**/${name}/**`)]),
      '.',
      `| head -n ${maxFiles}`,
    ].join(' ')

    this.log('walkDirWithRg:start', { root, cmd: cmd.slice(0, 240), rgPath: this.rgPath })
    const output = await platform.shell.run(cmd, { cwd: root, timeout: 10_000 })
    const results = output.trim().split('\n').filter(Boolean)
      .map(relPath => this.makeFileEntry(platform.path.join(root, relPath), root, currentDir))
    this.log('walkDirWithRg:done', { root, count: results.length })
    return results
  }

  private getFzfInputPath(): string {
    return platform.path.join(platform.dataDir, 'cache', 'fuzzy-search-fzf-input.txt')
  }

  private async ensureFzfInputFile(): Promise<void> {
    if (!this.fzfInputDirty && this.fzfInputPath) return

    const cacheDir = platform.path.dirname(this.getFzfInputPath())
    await platform.fs.mkdir(cacheDir)

    const lines: string[] = []
    this.fzfInputMap.clear()
    for (let index = 0; index < this.allFiles.length; index++) {
      const file = this.allFiles[index]
      const id = String(index)
      this.fzfInputMap.set(id, file)

      const keys = [file.cwdRelPath, file.relPath, file.basename]
      const seen = new Set<string>()
      for (const key of keys) {
        const normalized = normalizePath(key).trim()
        if (!normalized || seen.has(normalized)) continue
        seen.add(normalized)
        lines.push(`${id}\t${normalized}`)
      }
    }

    this.fzfInputPath = this.getFzfInputPath()
    await this.writeLargeText(this.fzfInputPath, lines.join('\n') + (lines.length ? '\n' : ''))
    this.fzfInputDirty = false
    this.log('fzfInput:written', { path: this.fzfInputPath, lineCount: lines.length, fileCount: this.allFiles.length })
  }

  private async searchWithFzf(query: string, limit = 50): Promise<FileEntry[]> {
    if (!this.fzfPath) return []
    await this.ensureFzfInputFile()
    const tabDelimiter = '	'

    const cmd = [
      'cat',
      platform.shell.escape(this.fzfInputPath),
      '|',
      platform.shell.escape(this.fzfPath),
      '--filter',
      platform.shell.escape(query),
      '--algo=v2',
      '--scheme=path',
      '--delimiter',
      platform.shell.escape(tabDelimiter),
      '--nth=2..',
      `| head -n ${limit * 4}`,
    ].join(' ')

    const output = await platform.shell.run(cmd, { timeout: 10_000 })
    const results: FileEntry[] = []
    const seen = new Set<string>()

    for (const line of output.trim().split('\n').filter(Boolean)) {
      const tabIndex = line.indexOf('\t')
      if (tabIndex <= 0) continue
      const id = line.slice(0, tabIndex)
      const file = this.fzfInputMap.get(id)
      if (!file || seen.has(file.absPath)) continue
      seen.add(file.absPath)
      results.push(file)
      if (results.length >= limit) break
    }

    this.searchBackend = 'fzf'
    return results
  }

  private pushTopResult(
    results: Array<{ file: FileEntry; score: number }>,
    candidate: { file: FileEntry; score: number },
    limit: number,
  ): void {
    let index = 0
    while (index < results.length && results[index]!.score >= candidate.score) index += 1
    if (index >= limit) return
    results.splice(index, 0, candidate)
    if (results.length > limit) results.length = limit
  }

  private searchWithJs(query: string, limit = 50): FileEntry[] {
    this.searchBackend = 'js'
    const normalizedQuery = query.trim().toLowerCase()
    const canNarrow =
      this.searchPoolVersion === this.searchCacheVersion &&
      !!this.lastSearchQuery &&
      normalizedQuery.startsWith(this.lastSearchQuery)
    const source = canNarrow ? this.searchPool : this.allFiles
    const matchedPool: FileEntry[] = []
    const topResults: Array<{ file: FileEntry; score: number }> = []

    for (const file of source) {
      const score = scoreFile(file, normalizedQuery)
      if (score === -Infinity) continue
      matchedPool.push(file)
      this.pushTopResult(topResults, { file, score }, limit)
    }

    this.lastSearchQuery = normalizedQuery
    this.searchPool = matchedPool
    this.searchPoolVersion = this.searchCacheVersion
    return topResults.map(entry => entry.file)
  }

  private shouldUseExternalFzf(query: string): boolean {
    return !IS_MAC && !!this.fzfPath && this.allFiles.length >= EXTERNAL_FZF_THRESHOLD && query.trim().length >= 2
  }

  private async searchFiles(query: string, limit = 50): Promise<FileEntry[]> {
    if (this.shouldUseExternalFzf(query)) {
      try {
        return await this.searchWithFzf(query, limit)
      } catch (err) {
        this.warn('searchWithFzf failed, falling back to JS scoring', err)
      }
    }
    return this.searchWithJs(query, limit)
  }

  private mergeFileEntries(primary: FileEntry[], secondary: FileEntry[]): FileEntry[] {
    const merged = new Map<string, FileEntry>()
    for (const entry of [...primary, ...secondary]) merged.set(entry.absPath, entry)
    return [...merged.values()]
  }

  private rehydrateEntries(entries: FileEntry[], root: string, currentDir = this.getCurrentDir()): FileEntry[] {
    return entries.map(entry => this.makeFileEntry(entry.absPath, root, currentDir, entry.basename))
  }

  private setFooter(fileCount: number, root: string, status = ''): void {
    const parts = [
      `${fileCount} 个文件`,
      root || '(无)',
      `索引:${this.indexBackend}`,
      `搜索:${this.searchBackend}`,
    ]
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
    await this.ensureToolInfo()

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
      quickFiles.push(this.makeFileEntry(absPath, root, currentDir))
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
          quickFiles.push(this.makeFileEntry(absPath, root, currentDir, name))
        }
      } catch (err) {
        this.warn('failed to list current dir', { currentDir, err })
      }
    }

    this.allFiles = quickFiles
    this.fzfInputDirty = true
    this.invalidateSearchCache()
    this.log('loadFiles:phase1-complete', {
      root,
      currentDir,
      quickFileCount: quickFiles.length,
      quickFilesSample: quickFiles.slice(0, DEBUG_SAMPLE_LIMIT).map(f => f.relPath),
    })
    this.setFooter(quickFiles.length, root || currentDir, root ? '正在索引整个文件夹…' : '')
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
      this.vaultIndex = this.rehydrateEntries(this.vaultIndex, root)
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
      const rgEntries = await this.collectVaultIndexWithRg(root, 5000).catch(err => {
        this.warn('walkDirWithRg failed', { root, err })
        return [] as FileEntry[]
      })
      const primaryEntries = rgEntries.length > 0
        ? rgEntries
        : await this.walkDirPure(root, 20, 5000)
      const fallbackEntries = primaryEntries.length > 0
        ? []
        : this.mergeFileEntries(
            this.collectVaultIndexFromLibrary(root, 20, 5000),
            await this.collectVaultIndexFromBridge(root, 5000),
          )
      this.indexBackend = rgEntries.length > 0 ? 'rg' : 'walk'
      const allEntries = this.mergeFileEntries(
        primaryEntries,
        fallbackEntries,
      )
      this.log('loadVaultIndex:sources', {
        root,
        rgCount: rgEntries.length,
        primaryCount: primaryEntries.length,
        libraryCount: fallbackEntries.length,
        bridgeCount: 0,
        backend: this.indexBackend,
        mergedCount: allEntries.length,
      })
      this.vaultIndex = this.rehydrateEntries(allEntries, root)

      this.vaultIndexRoot = root
      this.vaultIndexTime = Date.now()
      this.log('loadVaultIndex:done', {
        root,
        durationMs: Date.now() - startedAt,
        count: this.vaultIndex.length,
        sample: this.vaultIndex.slice(0, DEBUG_SAMPLE_LIMIT).map(f => f.relPath),
      })
      this.mergeVaultIndex(alreadySeen)
    } catch (err) {
      this.warn('vault index failed', { root, err })
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
      this.fzfInputDirty = true
      this.invalidateSearchCache()
    }

    const root = this.getRootDir()
    this.log('mergeVaultIndex', {
      root,
      newEntries: newEntries.length,
      totalFiles: this.allFiles.length,
      sample: newEntries.slice(0, DEBUG_SAMPLE_LIMIT).map(f => f.relPath),
    })
    this.setFooter(this.allFiles.length, root, '')
    if (this.overlay) {
      void this.renderList(this.inputEl?.value ?? this.currentQuery)
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
    this.lastHandledEnterAt = 0
    this.openingSelection = false
    this.log('open:start', {
      filePath: editor.getFilePath(),
      fileName: editor.getFileName(),
      watchedFolder: editor.getWatchedFolder(),
    })
    this.buildModal()
    await this.loadFiles()
    if (this.overlay) {
      void this.renderList('')
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
    this.lastSearchQuery = ''
    this.searchPool = []
    this.searchPoolVersion = -1
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
    input.placeholder = '搜索文件名、工作区路径或相对当前文件的路径...'
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
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => { void this.renderList(input.value) }, DEBOUNCE_MS)
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

    void this.renderList('')
    setTimeout(() => input.focus(), 30)
  }

  private updateFooter(text: string): void {
    const el = this.overlay?.querySelector('#tpl-qo-footer')
    if (el) el.textContent = text
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  private async renderList(query: string): Promise<void> {
    const list = this.listEl
    if (!list) return
    const token = ++this.renderToken
    this.currentQuery = query
    list.innerHTML = ''

    if (!this.allFiles.length) {
      list.appendChild(this.makeStatus('未找到 Markdown 文件'))
      return
    }

    if (query.trim()) {
      this.searchBackend = this.shouldUseExternalFzf(query) ? 'fzf' : 'js'
      list.appendChild(this.makeStatus(`搜索中… (${this.searchBackend})`))
      const results = await this.searchFiles(query, SEARCH_RESULT_LIMIT)
      if (token !== this.renderToken || !this.listEl) return

      this.filtered = results
      list.innerHTML = ''
      this.setFooter(this.allFiles.length, this.getRootDir(), query ? `查询:${query}` : '')
      this.log('renderList:query', {
        query,
        indexedFiles: this.allFiles.length,
        resultCount: this.filtered.length,
        topResults: this.filtered.slice(0, 10).map(f => f.relPath),
        fzfPath: this.fzfPath,
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
      this.setFooter(this.allFiles.length, root || currentDir, '')

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

  private getItemPathText(f: FileEntry): string {
    if (this.currentQuery.trim() && isRelativePathQuery(this.currentQuery) && f.cwdRelPath !== f.relPath) {
      return f.cwdRelPath
    }
    const lastSlash = f.relPath.lastIndexOf('/')
    return lastSlash > 0 ? f.relPath.slice(0, lastSlash) : '/'
  }

  private getItemPathTitle(f: FileEntry): string {
    if (f.cwdRelPath === f.relPath) return f.relPath
    return `workspace: ${f.relPath}\ncurrent: ${f.cwdRelPath}`
  }

  private renderHighlightedText(el: HTMLElement, text: string): void {
    const query = this.currentQuery.trim()
    const positions = query ? fuzzyMatchPositions(text, query) : []
    if (!query || !positions || positions.length === 0) {
      el.textContent = text
      return
    }

    el.textContent = ''
    const hitSet = new Set(positions)
    let plain = ''
    let highlighted = ''

    const flushPlain = (): void => {
      if (!plain) return
      el.appendChild(document.createTextNode(plain))
      plain = ''
    }

    const flushHighlight = (): void => {
      if (!highlighted) return
      const span = document.createElement('mark')
      span.className = 'tpl-qo-hit'
      span.textContent = highlighted
      el.appendChild(span)
      highlighted = ''
    }

    for (let index = 0; index < text.length; index++) {
      const ch = text[index] ?? ''
      if (hitSet.has(index)) {
        flushPlain()
        highlighted += ch
      } else {
        flushHighlight()
        plain += ch
      }
    }

    flushPlain()
    flushHighlight()
  }

  private makeItem(f: FileEntry, idx: number): HTMLElement {
    const item = document.createElement('div')
    item.className = 'tpl-qo-item' + (idx === this.selectedIdx ? ' tpl-qo-selected' : '')

    const name = document.createElement('div')
    name.className = 'tpl-qo-name'
    this.renderHighlightedText(name, f.basename)

    const pathEl = document.createElement('div')
    pathEl.className = 'tpl-qo-path'
    this.renderHighlightedText(pathEl, this.getItemPathText(f))
    pathEl.title = this.getItemPathTitle(f)

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
    // Skip when IME is composing (e.g. Chinese input confirming pinyin with Enter)
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      this.selectedIdx = Math.min(this.selectedIdx + 1, this.filtered.length - 1)
      this.highlight()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      this.selectedIdx = Math.max(this.selectedIdx - 1, 0)
      this.highlight()
    } else if (e.key === 'Enter') {
      if (e.repeat) return
      const now = Date.now()
      if (now - this.lastHandledEnterAt < 180) return
      this.lastHandledEnterAt = now
      e.preventDefault()
      e.stopPropagation()
      this.openSelected()
    }
  }

  private openSelected(): void {
    const f = this.filtered[this.selectedIdx]
    if (!f || this.openingSelection) return
    this.openingSelection = true
    this.log('openSelected', { index: this.selectedIdx, file: f })
    this.close()
    this.recordOpen(f.absPath).catch(() => {})
    editor.openFile(f.absPath)
      .catch(err => {
        this.warn('openSelected failed', { file: f.absPath, err })
        this.showNotice(`打开文件失败: ${err.message}`)
      })
      .finally(() => {
        this.openingSelection = false
      })
  }
}
