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

interface InstallPlan {
  manager: string
  label: string
  command: string
  canRunDirectly: boolean
}

const MD_EXTS = ['.md', '.markdown']
const MD_EXT_SET = new Set(MD_EXTS)
const MAX_MRU = 30
const DEFAULT_HOTKEYS = ['Mod+.', "Mod+'"]
const DEBOUNCE_MS = 120
const INDEX_TTL_MS = 5 * 60_000
const SEARCH_RESULT_LIMIT = 100
const IGNORED_DIRS = ['.git', 'node_modules', '.obsidian', '.trash', '.Trash', '_archive']
const TAG = '[tpl:quick-open]'
const DEBUG_SAMPLE_LIMIT = 20
const DEBUG = false
const INDEX_SCHEMA_VERSION = 1

interface PersistedIndexMeta {
  schemaVersion: number
  root: string
  count: number
  updatedAt: number
}

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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch
  ))
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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
#tpl-qo-footer-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
#tpl-qo-footer-action {
  border: 1px solid var(--border-color, rgba(128,128,128,0.2));
  background: transparent;
  color: inherit;
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
  opacity: 0.9;
  flex-shrink: 0;
}
#tpl-qo-footer-action:hover {
  background: rgba(128,128,128,0.08);
}
#tpl-qo-footer-action[hidden] {
  display: none;
}
#tpl-qo-footer-action:disabled {
  cursor: default;
  opacity: 0.45;
}
`

export default class QuickOpenPlugin extends Plugin {
  private overlay: HTMLElement | null = null
  private inputEl: HTMLInputElement | null = null
  private listEl: HTMLElement | null = null
  private footerTextEl: HTMLElement | null = null
  private footerActionEl: HTMLButtonElement | null = null
  /** Recent files shown immediately before the persistent index is queried. */
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
  private fzfInstallPlanChecked = false
  private fzfInstallPlan: InstallPlan | null = null
  private indexBackend = 'walk'
  private searchBackend = 'js'
  private installInFlight = false
  private openingSelection = false
  private lastHandledEnterAt = 0
  private indexFilePath = ''
  private indexMetaPath = ''
  private indexRoot = ''
  private indexedFileCount = 0
  private indexReady = false
  private lastInputValue = ''
  private lastRecordedActiveFile = ''

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
    this.registerCommand({
      id: 'quick-open:install-fzf',
      name: 'Quick Open: Install fzf',
      callback: () => this.promptInstallFzf(),
    })
    this.syncActiveFileToRecent().catch(() => {})
    this.registerInterval(() => {
      void this.syncActiveFileToRecent()
    }, 1200)
  }

  onunload(): void {
    this.log('onunload', {
      indexedFiles: this.indexedFileCount,
      indexRoot: this.indexRoot,
      currentQuery: this.currentQuery,
    })
    this.close()
  }

  private async syncActiveFileToRecent(): Promise<void> {
    const activeFile = editor.getFilePath()
    if (!activeFile || activeFile === this.lastRecordedActiveFile) return
    this.lastRecordedActiveFile = activeFile
    await this.recordOpen(activeFile)
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

  private hashText(text: string): string {
    let hash = 2166136261
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  }

  private getIndexCacheDir(): string {
    return platform.path.join(platform.dataDir, 'cache', 'fuzzy-search')
  }

  private getIndexPaths(root: string): { dir: string; metaPath: string; filePath: string; tempPath: string } {
    const dir = this.getIndexCacheDir()
    const key = this.hashText(normalizePath(root).toLowerCase())
    const base = `index-${key}`
    return {
      dir,
      metaPath: platform.path.join(dir, `${base}.meta.json`),
      filePath: platform.path.join(dir, `${base}.paths.txt`),
      tempPath: platform.path.join(dir, `${base}.tmp.txt`),
    }
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

  private async loadPersistedIndexMeta(root: string): Promise<boolean> {
    const { dir, filePath, metaPath } = this.getIndexPaths(root)
    this.indexRoot = root
    this.indexFilePath = filePath
    this.indexMetaPath = metaPath
    this.indexedFileCount = 0
    this.vaultIndexTime = 0
    this.indexReady = false

    try {
      await platform.fs.mkdir(dir)
      const [metaExists, fileExists] = await Promise.all([
        platform.fs.exists(metaPath),
        platform.fs.exists(filePath),
      ])
      if (!metaExists || !fileExists) return false

      const meta = JSON.parse(await platform.fs.readText(metaPath)) as PersistedIndexMeta
      if (
        meta.schemaVersion !== INDEX_SCHEMA_VERSION ||
        normalizePath(meta.root) !== normalizePath(root) ||
        typeof meta.count !== 'number'
      ) {
        return false
      }

      this.indexedFileCount = meta.count
      this.indexReady = meta.count > 0
      this.vaultIndexTime = meta.updatedAt || 0
      return true
    } catch (err) {
      this.warn('loadPersistedIndexMeta failed', { root, err })
      return false
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
        vaultIndexCount: this.indexedFileCount,
        vaultIndexRoot: this.indexRoot,
        vaultIndexTime: this.vaultIndexTime ? new Date(this.vaultIndexTime).toISOString() : null,
        allFilesSample: this.allFiles.slice(0, DEBUG_SAMPLE_LIMIT),
        filteredSample: this.filtered.slice(0, DEBUG_SAMPLE_LIMIT),
        extra,
      }
      const indexDump = {
        reason,
        timestamp: state.timestamp,
        rootDir: this.indexRoot || this.getRootDir(),
        count: this.indexedFileCount,
        indexFilePath: this.indexFilePath,
      }

      await Promise.all([
        this.writeLargeText(statePath, JSON.stringify(state, null, 2) + '\n'),
        this.writeLargeText(indexPath, JSON.stringify(indexDump, null, 2) + '\n'),
      ])
      this.log('debug dump written', { reason, statePath, indexPath, count: this.indexedFileCount })
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

  private getCommandDetectCommand(name: string): string {
    if (this.getRuntimePlatform() === 'windows') {
      return `where ${name} 2>NUL`
    }
    return `command -v ${name} || which ${name} || true`
  }

  private async resolveCommandPath(name: string, candidates: string[] = []): Promise<string | null> {
    try {
      const out = (await platform.shell.run(this.getCommandDetectCommand(name), { timeout: 3000 })).trim()
      const path = out.split(/\r?\n/).find(Boolean)?.trim() ?? ''
      if (path) return path
    } catch {}

    for (const candidate of candidates) {
      try {
        if (await platform.fs.exists(candidate)) return candidate
      } catch {}
    }

    return null
  }

  private async resolveFzfInstallPlan(): Promise<InstallPlan | null> {
    const runtime = this.getRuntimePlatform()
    const defs = runtime === 'windows'
      ? [
          { manager: 'scoop', label: 'Scoop', command: 'scoop install fzf', canRunDirectly: true },
          { manager: 'winget', label: 'Winget', command: 'winget install fzf', canRunDirectly: false },
          { manager: 'choco', label: 'Chocolatey', command: 'choco install fzf', canRunDirectly: false },
        ]
      : runtime === 'macos'
        ? [
            {
              manager: 'brew',
              label: 'Homebrew',
              command: 'brew install fzf',
              canRunDirectly: true,
              candidates: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'],
            },
            { manager: 'mise', label: 'Mise', command: 'mise use -g fzf@latest', canRunDirectly: true },
            {
              manager: 'port',
              label: 'MacPorts',
              command: 'sudo port install fzf',
              canRunDirectly: false,
              candidates: ['/opt/local/bin/port'],
            },
          ]
        : [
            {
              manager: 'brew',
              label: 'Homebrew',
              command: 'brew install fzf',
              canRunDirectly: true,
              candidates: ['/home/linuxbrew/.linuxbrew/bin/brew'],
            },
            { manager: 'mise', label: 'Mise', command: 'mise use -g fzf@latest', canRunDirectly: true },
            { manager: 'apt', label: 'APT', command: 'sudo apt install fzf', canRunDirectly: false },
            { manager: 'dnf', label: 'DNF', command: 'sudo dnf install fzf', canRunDirectly: false },
            { manager: 'pacman', label: 'Pacman', command: 'sudo pacman -S fzf', canRunDirectly: false },
            { manager: 'zypper', label: 'Zypper', command: 'sudo zypper install fzf', canRunDirectly: false },
            { manager: 'apk', label: 'APK', command: 'sudo apk add fzf', canRunDirectly: false },
            { manager: 'conda', label: 'Conda', command: 'conda install -c conda-forge fzf', canRunDirectly: true },
            { manager: 'nix-env', label: 'Nix', command: 'nix-env -iA nixpkgs.fzf', canRunDirectly: true },
          ]

    for (const def of defs) {
      const path = await this.resolveCommandPath(def.manager, 'candidates' in def ? (def.candidates ?? []) : [])
      if (path) {
        this.log('fzf install plan detected', { manager: def.manager, path, canRunDirectly: def.canRunDirectly })
        return {
          manager: def.manager,
          label: def.label,
          command: def.command,
          canRunDirectly: def.canRunDirectly,
        }
      }
    }

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
    if (!this.fzfPath && !this.fzfInstallPlanChecked) {
      this.fzfInstallPlanChecked = true
      this.fzfInstallPlan = await this.resolveFzfInstallPlan()
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

  private async searchWithFzf(query: string, limit = 50): Promise<FileEntry[]> {
    if (!this.fzfPath || !this.indexReady || !this.indexFilePath || !this.indexRoot) return []
    const cmd = [
      'cat',
      platform.shell.escape(this.indexFilePath),
      '|',
      platform.shell.escape(this.fzfPath),
      '--filter',
      platform.shell.escape(query),
      '--algo=v2',
      '--scheme=path',
      `| head -n ${limit}`,
    ].join(' ')

    const output = await platform.shell.run(cmd, { timeout: 10_000 })
    const results: FileEntry[] = []
    const seen = new Set<string>()
    const root = this.indexRoot
    const currentDir = this.getCurrentDir()

    for (const line of output.trim().split('\n').filter(Boolean)) {
      const relPath = normalizePath(line.trim())
      if (!relPath) continue
      const absPath = platform.path.join(root, relPath)
      if (seen.has(absPath)) continue
      seen.add(absPath)
      results.push(this.makeFileEntry(absPath, root, currentDir))
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

  private async searchWithJs(query: string, limit = 50): Promise<FileEntry[]> {
    this.searchBackend = 'js'
    if (!this.indexReady || !this.indexFilePath || !this.indexRoot) return []

    const normalizedQuery = query.trim()
    const text = await platform.fs.readText(this.indexFilePath)
    const root = this.indexRoot
    const currentDir = this.getCurrentDir()
    const topResults: Array<{ file: FileEntry; score: number }> = []

    for (const relPath of text.split('\n').filter(Boolean)) {
      const absPath = platform.path.join(root, relPath)
      const file = this.makeFileEntry(absPath, root, currentDir)
      const score = scoreFile(file, normalizedQuery)
      if (score === -Infinity) continue
      this.pushTopResult(topResults, { file, score }, limit)
    }

    return topResults.map(entry => entry.file)
  }

  private shouldUseExternalFzf(query: string): boolean {
    return !!this.fzfPath && !!query.trim() && this.indexReady
  }

  private async searchFiles(query: string, limit = 50): Promise<FileEntry[]> {
    if (this.shouldUseExternalFzf(query)) {
      try {
        return await this.searchWithFzf(query, limit)
      } catch (err) {
        this.warn('searchWithFzf failed, falling back to JS scoring', err)
      }
    }
    return await this.searchWithJs(query, limit)
  }

  private async buildIndexWithRg(root: string): Promise<number> {
    if (!this.rgPath) return 0
    const { dir, filePath, tempPath } = this.getIndexPaths(root)
    await platform.fs.mkdir(dir)
    const cmd = [
      platform.shell.escape(this.rgPath),
      '--files',
      ...MD_EXTS.flatMap(ext => ['-g', platform.shell.escape(`*${ext}`)]),
      ...IGNORED_DIRS.flatMap(name => ['-g', platform.shell.escape(`!**/${name}/**`)]),
      '.',
      '>',
      platform.shell.escape(tempPath),
      '&&',
      'wc -l <',
      platform.shell.escape(tempPath),
    ].join(' ')

    const countText = (await platform.shell.run(cmd, { cwd: root, timeout: 30_000 })).trim()
    await platform.shell.run(
      `mv ${platform.shell.escape(tempPath)} ${platform.shell.escape(filePath)}`,
      { timeout: 10_000 },
    )
    return Number.parseInt(countText, 10) || 0
  }

  private async buildIndexWithFind(root: string): Promise<number> {
    const { dir, filePath, tempPath } = this.getIndexPaths(root)
    await platform.fs.mkdir(dir)
    const esc = (s: string) => platform.shell.escape(s)
    const ignorePrune = IGNORED_DIRS.map(d => `-name ${esc(d)}`).join(' -o ')
    const extMatch = MD_EXTS.map(e => `-name ${esc('*' + e)}`).join(' -o ')
    const cmd = [
      'find .',
      `\\( -type d \\( ${ignorePrune} -o -name '.*' \\) -prune \\)`,
      '-o',
      `-type f \\( ${extMatch} \\) -print`,
      '| sed',
      esc('s#^\\./##'),
      '>',
      esc(tempPath),
      '&&',
      'wc -l <',
      esc(tempPath),
    ].join(' ')

    const countText = (await platform.shell.run(cmd, { cwd: root, timeout: 60_000 })).trim()
    await platform.shell.run(`mv ${esc(tempPath)} ${esc(filePath)}`, { timeout: 10_000 })
    return Number.parseInt(countText, 10) || 0
  }

  private async persistIndexMeta(root: string, count: number): Promise<void> {
    const meta: PersistedIndexMeta = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      root,
      count,
      updatedAt: Date.now(),
    }
    await this.writeLargeText(this.indexMetaPath, JSON.stringify(meta, null, 2) + '\n')
  }

  private async buildPersistentIndex(root: string): Promise<void> {
    const startedAt = Date.now()
    await this.loadPersistedIndexMeta(root)

    let count = 0
    if (this.rgPath) {
      count = await this.buildIndexWithRg(root)
      this.indexBackend = 'rg'
    } else {
      count = await this.buildIndexWithFind(root)
      this.indexBackend = 'find'
    }

    this.indexRoot = root
    this.indexedFileCount = count
    this.indexReady = count > 0
    await this.persistIndexMeta(root, count)
    this.log('buildPersistentIndex:done', {
      root,
      count,
      durationMs: Date.now() - startedAt,
      indexFilePath: this.indexFilePath,
      backend: this.indexBackend,
    })
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
    this.updateFooterAction()
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
    this.log('loadFiles:start', { root, currentDir, candidates, cacheRoot: this.indexRoot, cacheCount: this.indexedFileCount })
    await this.ensureToolInfo()
    this.indexReady = root ? await this.loadPersistedIndexMeta(root) : false

    let mru = this.getMru()
    this.log('loadFiles:mru', { count: mru.length, sample: mru.slice(0, DEBUG_SAMPLE_LIMIT) })
    if (mru.length > 0) {
      try {
        const existing = await Promise.all(
          mru.map(async p => {
            try {
              return await platform.fs.exists(p) ? p : null
            } catch {
              return null
            }
          }),
        )
        const before = mru.length
        mru = existing.filter((p): p is string => !!p)
        if (mru.length < before) {
          this.log('loadFiles:mru-pruned', { before, after: mru.length })
          this.saveMru(mru).catch(() => {})
        }
      } catch (err) {
        this.warn('loadFiles:mru-existence-check-failed', err)
      }
    }
    this.allFiles = mru.map(absPath => this.makeFileEntry(absPath, root, currentDir))
    this.filtered = [...this.allFiles]
    this.log('loadFiles:phase1-complete', {
      root,
      currentDir,
      recentCount: this.allFiles.length,
      recentSample: this.allFiles.slice(0, DEBUG_SAMPLE_LIMIT).map(f => f.relPath),
      indexReady: this.indexReady,
      indexedFileCount: this.indexedFileCount,
    })
    this.setFooter(
      this.indexedFileCount || this.allFiles.length,
      root || currentDir,
      root && !this.indexReady ? '正在构建索引…' : '',
    )
    if (root) {
      this.log('loadFiles:phase2-dispatch', { root })
      void this.loadVaultIndex(root)
    } else {
      this.warn('loadFiles:no-root', { currentDir, candidates })
    }
  }

  private async loadVaultIndex(root: string): Promise<void> {
    if (this.indexing) {
      this.log('loadVaultIndex:skip-already-indexing', { root, currentRoot: this.indexRoot })
      return
    }

    if (
      this.indexReady &&
      this.indexRoot === root &&
      this.vaultIndexTime &&
      Date.now() - this.vaultIndexTime < INDEX_TTL_MS
    ) {
      this.log('loadVaultIndex:cache-hit', {
        root,
        ageMs: Date.now() - this.vaultIndexTime,
        count: this.indexedFileCount,
      })
      return
    }

    this.indexing = true
    const startedAt = Date.now()
    this.setFooter(this.indexedFileCount || this.allFiles.length, root, '正在构建索引…')
    this.log('loadVaultIndex:start', {
      root,
      ignoredDirs: IGNORED_DIRS,
      currentIndexPath: this.indexFilePath,
    })

    try {
      await this.buildPersistentIndex(root)
      this.vaultIndex = []
      this.vaultIndexRoot = root
      this.vaultIndexTime = Date.now()
      this.log('loadVaultIndex:done', {
        root,
        durationMs: Date.now() - startedAt,
        count: this.indexedFileCount,
        indexFilePath: this.indexFilePath,
        backend: this.indexBackend,
      })
      this.mergeVaultIndex()
    } catch (err) {
      this.warn('vault index failed', { root, err })
    } finally {
      this.indexing = false
    }
  }

  private mergeVaultIndex(): void {
    const root = this.getRootDir()
    this.log('mergeVaultIndex', {
      root,
      totalFiles: this.indexedFileCount,
      indexFilePath: this.indexFilePath,
      indexReady: this.indexReady,
    })
    this.setFooter(this.indexedFileCount || this.allFiles.length, root, '')
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
    this.footerTextEl = null
    this.footerActionEl = null
    this.filtered = []
    this.selectedIdx = 0
    this.currentQuery = ''
    this.lastInputValue = ''
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
    const footerText = document.createElement('div')
    footerText.id = 'tpl-qo-footer-text'
    footerText.textContent = '加载中...'
    const footerAction = document.createElement('button')
    footerAction.id = 'tpl-qo-footer-action'
    footerAction.type = 'button'
    footerAction.textContent = '安装 fzf'
    footerAction.hidden = true
    footerAction.addEventListener('click', () => { void this.promptInstallFzf() })
    footer.appendChild(footerText)
    footer.appendChild(footerAction)

    modal.appendChild(inputRow)
    modal.appendChild(list)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    this.overlay = overlay
    this.inputEl = input
    this.listEl = list
    this.footerTextEl = footerText
    this.footerActionEl = footerAction

    const onInput = () => {
      const nextQuery = input.value
      if (nextQuery === this.lastInputValue) return
      this.lastInputValue = nextQuery
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        if (input.value === this.currentQuery) return
        void this.renderList(input.value)
      }, DEBOUNCE_MS)
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
    if (this.footerTextEl) this.footerTextEl.textContent = text
  }

  private updateFooterAction(): void {
    if (!this.footerActionEl) return
    const shouldShow = !this.fzfPath
    this.footerActionEl.hidden = !shouldShow
    this.footerActionEl.disabled = this.installInFlight
    if (!shouldShow) return
    if (this.installInFlight) {
      this.footerActionEl.textContent = '安装中...'
      return
    }
    this.footerActionEl.textContent = this.fzfInstallPlan ? '安装 fzf' : '安装说明'
    const detail = this.fzfInstallPlan ? `${this.fzfInstallPlan.label}: ${this.fzfInstallPlan.command}` : '未检测到可用包管理器'
    this.footerActionEl.title = detail
  }

  private async promptInstallFzf(): Promise<void> {
    await this.ensureToolInfo()
    if (this.fzfPath) {
      this.showNotice('已检测到 fzf')
      this.updateFooterAction()
      return
    }

    const showDialog = window.File?.editor?.EditHelper?.showDialog
    const plan = this.fzfInstallPlan
    const html = plan
      ? `<div>未检测到 <code>fzf</code>。检测到可用包管理器：<strong>${escapeHtml(plan.label)}</strong>。</div>
         <div style="margin-top:8px"><code>${escapeHtml(plan.command)}</code></div>
         <div style="margin-top:8px; opacity:.75">${plan.canRunDirectly ? '可直接由插件尝试执行安装命令。' : '该命令通常需要终端交互或 sudo，插件只提供复制。'}</div>`
      : `<div>未检测到 <code>fzf</code>，也没有识别到支持的包管理器。</div>
         <div style="margin-top:8px; opacity:.75">请根据系统手动安装后重新打开 Quick Open。</div>`

    if (!showDialog) {
      if (plan) {
        await navigator.clipboard.writeText(plan.command).catch(() => {})
        this.showNotice('已复制 fzf 安装命令')
      } else {
        this.showNotice('未检测到可用的 fzf 安装方式')
      }
      return
    }

    const buttons = plan
      ? (plan.canRunDirectly ? ['Run install', 'Copy command', 'Cancel'] : ['Copy command', 'Close'])
      : ['Close']

    showDialog({
      title: 'Install fzf',
      html,
      buttons,
      callback: (index) => {
        if (!plan) return
        if (plan.canRunDirectly) {
          if (index === 0) void this.runFzfInstall(plan)
          if (index === 1) void navigator.clipboard.writeText(plan.command).then(() => this.showNotice('已复制安装命令')).catch(() => this.showNotice('复制安装命令失败'))
          return
        }
        if (index === 0) void navigator.clipboard.writeText(plan.command).then(() => this.showNotice('已复制安装命令')).catch(() => this.showNotice('复制安装命令失败'))
      },
    })
  }

  private async runFzfInstall(plan: InstallPlan): Promise<void> {
    if (this.installInFlight) return
    this.installInFlight = true
    this.updateFooterAction()
    this.showNotice(`正在通过 ${plan.label} 安装 fzf...`, 4000)
    try {
      await platform.shell.run(plan.command, { timeout: 10 * 60_000 })
      this.fzfChecked = false
      this.fzfInstallPlanChecked = false
      this.fzfPath = null
      this.fzfInstallPlan = null
      await this.ensureToolInfo()
      if (this.fzfPath) {
        this.showNotice(`fzf 已安装 (${this.fzfPath})`)
      } else {
        this.showNotice('安装命令已完成，请重新打开 Quick Open 验证 fzf 是否可用', 5000)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.warn('runFzfInstall failed', { plan, err })
      this.showNotice(`安装 fzf 失败: ${message}`, 5000)
    } finally {
      this.installInFlight = false
      this.updateFooterAction()
      if (this.overlay) {
        const root = this.getRootDir() || this.getCurrentDir()
        this.setFooter(this.indexedFileCount || this.allFiles.length, root, this.currentQuery ? `查询:${this.currentQuery}` : '')
      }
    }
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

    if (query.trim()) {
      this.searchBackend = this.shouldUseExternalFzf(query) ? 'fzf' : 'js'
      if (!this.indexReady) {
        this.filtered = []
        list.appendChild(this.makeStatus('索引尚未准备好，正在后台构建…'))
        this.setFooter(this.indexedFileCount || this.allFiles.length, this.getRootDir(), '等待索引完成')
        return
      }

      list.appendChild(this.makeStatus(`搜索中… (${this.searchBackend})`))
      const results = await this.searchFiles(query, SEARCH_RESULT_LIMIT)
      if (token !== this.renderToken || !this.listEl) return

      this.filtered = results
      list.innerHTML = ''
      this.setFooter(this.indexedFileCount || this.allFiles.length, this.getRootDir(), query ? `查询:${query}` : '')
      this.log('renderList:query', {
        query,
        indexedFiles: this.indexedFileCount || this.allFiles.length,
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
      const mru = this.getMru()
      const mruFiles = mru
        .map(p => this.makeFileEntry(p, this.getRootDir(), this.getCurrentDir()))
        .slice(0, MAX_MRU)

      const root = this.getRootDir()
      this.filtered = [...mruFiles]
      this.log('renderList:default', {
        indexedFiles: this.indexedFileCount || this.allFiles.length,
        mruCount: mruFiles.length,
        indexReady: this.indexReady,
      })
      this.selectedIdx = 0
      this.setFooter(
        this.indexedFileCount || this.allFiles.length,
        root || this.getCurrentDir(),
        this.indexReady ? '' : (root ? '正在构建索引…' : ''),
      )

      if (mruFiles.length) {
        list.appendChild(this.makeSectionLabel('最近打开'))
        mruFiles.forEach((f, idx) => list.appendChild(this.makeItem(f, idx)))
      } else {
        list.appendChild(this.makeStatus(this.indexReady ? '暂无最近打开文件' : '暂无最近打开文件，索引正在后台构建…'))
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
    this.lastRecordedActiveFile = f.absPath
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
