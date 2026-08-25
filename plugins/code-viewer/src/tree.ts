/**
 * CodeTree: makes Typora's sidebar file tree show non-Markdown text files and
 * routes their clicks into the code viewer's forced-open mode.
 *
 * How it works, after live-probing the running app:
 *
 * - The tree is plain DOM rendered by `library.fileTree.renderNode(node)` from
 *   a per-directory data model (`node.subdir`, `node.content`). Membership is
 *   gated upstream by a module-internal `displayFilter` we cannot reach, so
 *   non-Markdown files never enter the model. We splice our own entries in a
 *   `renderNode` wrapper: every directory render first re-syncs its `content`
 *   from our cache (built by one `find` over the mount folder), which keeps
 *   expand/collapse/refresh and lazily-fetched dirs correct with no extra work.
 * - Typora's own open path refuses unsupported extensions (its `openFile`
 *   no-ops), so a capture-phase click listener on `#file-library-tree`
 *   intercepts clicks on our entries before the jQuery delegation sees them
 *   and hands the path to the code viewer. Everything else passes through.
 * - Filesystem changes arrive through `fileTree.onChangeForMac` (FSEvents via
 *   the native bridge); the wrapper re-scans affected dirs and repaints them.
 */

import { editor, platform } from '@typora-plugin-lite/core'

import { languageFor } from './languages.js'

const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.claude', '.note-assistant',
  'dist', '.omc', '.obsidian', '.trash', '.Trash',
])

/** Extensions the viewer cannot meaningfully render; kept out of the tree. */
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tiff',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z', 'tar',
  'dmg', 'pkg', 'app', 'exe', 'dll', 'so', 'dylib', 'bin', 'dat',
  'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'wav', 'flac', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'sqlite', 'sqlite3', 'db', 'jar', 'class', 'pyc', 'o', 'a',
])

interface TreeNodeData {
  path: string
  name: string
  isDirectory: boolean
  content?: TreeNodeData[]
  subdir?: TreeNodeData[]
  isOpen?: boolean
  fetched?: boolean
  /** Marks entries injected by us (so removal never touches native nodes). */
  __cv?: boolean
  [key: string]: unknown
}

interface FileTreeLike {
  renderNode: (node: TreeNodeData, ...args: unknown[]) => unknown
  onChangeForMac: (events: Array<{ path: string; type?: string }>) => unknown
  getRoot?: () => TreeNodeData | null
  findNodeFromPath: (path: string, chain?: unknown[]) => TreeNodeData | null
  findElemFromPath: (path: string) => { length: number; replaceWith: (fresh: unknown) => void } | null
}

interface DirWatchEvent {
  path: string
  oldPath?: string
  isDir?: boolean
  type?: string
}

export class CodeTree {
  private scanRoot = ''
  /** dirPath -> our file entries for that directory (non-recursive). */
  private cache = new Map<string, TreeNodeData[]>()
  private restores: Array<() => void> = []
  private rescanTimer = 0
  private pendingDirs = new Set<string>()
  private attached = false
  private treeEl: HTMLElement | null = null
  private onTreeClick = (evt: MouseEvent): void => {
    if (evt.metaKey || evt.ctrlKey) return
    const target = evt.target instanceof HTMLElement ? evt.target : null
    const node = target?.closest('.file-tree-node') as HTMLElement | null
    if (!node || node.getAttribute('data-is-directory') === 'true') return
    const path = node.getAttribute('data-path') || ''
    if (!this.isOurs(path)) return
    // Typora's own handler would no-op on unsupported extensions anyway;
    // stop it before the jQuery delegation runs and open in the viewer.
    evt.preventDefault()
    evt.stopPropagation()
    document.querySelectorAll('.file-tree-node.active').forEach(el => el.classList.remove('active'))
    node.classList.add('active')
    this.openForced(path)
  }

  constructor(private openForced: (path: string) => void) {}

  /** Idempotent: safe to call from the plugin's poll until the library exists. */
  attach(): boolean {
    // The sidebar container can be rebuilt by Typora; re-latch the listener
    // onto the live element when the old one fell out of the document.
    if (this.attached) {
      if (this.treeEl && !this.treeEl.isConnected) {
        this.treeEl.removeEventListener('click', this.onTreeClick, true)
        this.treeEl = null
        this.installClickInterceptor()
      }
      return true
    }
    const fileTree = this.fileTree()
    if (!fileTree) return false
    const root = this.mountFolder()
    if (!root) return false
    // Do not latch without a clickable tree container: entries would render
    // but clicks would fall through to Typora's no-op handler.
    if (!document.getElementById('file-library-tree')) return false

    this.scanRoot = root.endsWith('/') ? root.slice(0, -1) : root
    this.attached = true
    this.hookRenderNode(fileTree)
    this.hookOnChange(fileTree)
    this.installClickInterceptor()
    void this.fullScan(fileTree)
    return true
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    window.clearTimeout(this.rescanTimer)
    this.pendingDirs.clear()
    if (this.treeEl) {
      this.treeEl.removeEventListener('click', this.onTreeClick, true)
      this.treeEl = null
    }
    for (const restore of this.restores.splice(0)) {
      try { restore() } catch {}
    }
    // Splice our entries back out so the tree returns to its native state.
    const fileTree = this.fileTree()
    if (fileTree) {
      for (const [dirPath] of this.cache) {
        const node = this.findNode(fileTree, dirPath)
        if (!node?.content) continue
        const before = node.content.length
        node.content = node.content.filter(item => !item.__cv)
        if (node.content.length !== before) this.repaintDir(fileTree, dirPath)
      }
    }
    this.cache.clear()
    this.scanRoot = ''
  }

  private fileTree(): FileTreeLike | null {
    const ft = (window as any).File?.editor?.library?.fileTree
    return ft && typeof ft.renderNode === 'function' ? (ft as FileTreeLike) : null
  }

  private mountFolder(): string {
    const win = window as any
    return editor.getWatchedFolder()
      || editor.getMountFolder()
      || win.File?.getMountFolder?.()
      || ''
  }

  private findNode(fileTree: FileTreeLike, path: string): TreeNodeData | null {
    try {
      return fileTree.findNodeFromPath(path, []) || null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- scanning

  private shellFind(dir: string, maxDepth: number): string {
    const prune = [...IGNORE_DIRS].map(name => `-name '${name}'`).join(' -o ')
    // -mindepth 1 keeps a root literally named "dist"/"node_modules" from
    // matching its own prune rule and silently scanning nothing.
    const depth = maxDepth > 0 ? `-maxdepth ${maxDepth}` : ''
    // Filter BEFORE the bridge: an unfiltered vault listing is ~9k lines and
    // controller.runCommand rejects that transfer (empty cache, feature dead).
    // The md/dotfile drop leaves a few hundred lines, which crosses fine.
    return `find ${platform.shell.escape(dir)} ${depth} -mindepth 1 -type d \\( ${prune} \\) -prune -o -type f -not -name '.*' -print 2>/dev/null | grep -vE '/\\.[^/]+/' | grep -viE '\\.(md|markdown|mdown|mkd|mdx)$'`
  }

  private parseListing(text: string): Map<string, TreeNodeData[]> {
    const byDir = new Map<string, TreeNodeData[]>()
    const prefix = this.scanRoot.endsWith('/') ? this.scanRoot : `${this.scanRoot}/`
    for (const line of text.split('\n')) {
      const file = line.trim()
      if (!file) continue
      // Skip dot-segments anywhere under the scan root (.github/, .ace-tool/…);
      // the basename check alone cannot see them.
      const rel = file.startsWith(prefix) ? file.slice(prefix.length) : file
      if (rel.split('/').some(seg => seg.startsWith('.'))) continue
      const name = file.split('/').pop() || ''
      if (!this.isTreeWorthy(name)) continue
      const dir = file.slice(0, file.length - name.length - 1)
      const list = byDir.get(dir) || []
      list.push({
        path: file,
        name,
        isDirectory: false,
        lastModified: new Date(),
        createDate: new Date(),
      })
      byDir.set(dir, list)
    }
    return byDir
  }

  /** A file belongs in the tree when the viewer can render it and it is not binary noise. */
  private isTreeWorthy(name: string): boolean {
    if (!name || name.startsWith('.')) return false
    if (languageFor(name) === null) return false // markdown: native tree already shows those
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    return !BINARY_EXTS.has(ext)
  }

  private async fullScan(fileTree: FileTreeLike): Promise<void> {
    let map: Map<string, TreeNodeData[]>
    try {
      const out = await platform.shell.run(this.shellFind(this.scanRoot, 0), { timeout: 30_000 })
      map = this.parseListing(out)
    } catch (err) {
      console.warn('[tpl:code-viewer] tree scan failed', err)
      return
    }
    if (!this.attached) return
    this.cache = map
    this.repaintVisible(fileTree)
  }

  private async rescanDirs(fileTree: FileTreeLike): Promise<void> {
    const dirs = [...this.pendingDirs]
    this.pendingDirs.clear()
    for (const dir of dirs) {
      try {
        const out = await platform.shell.run(this.shellFind(dir, 1), { timeout: 10_000 })
        if (!this.attached) return
        const parsed = this.parseListing(out)
        const next = parsed.get(dir) || []
        const prev = this.cache.get(dir) || []
        const same = next.length === prev.length && next.every(item => prev.some(p => p.path === item.path))
        if (same) continue
        this.cache.set(dir, next)
        this.repaintDir(fileTree, dir)
      } catch (err) {
        console.warn('[tpl:code-viewer] tree rescan failed', dir, err)
      }
    }
  }

  // ------------------------------------------------------------------ hooks

  /** Every directory render first re-syncs its content from the cache. */
  private hookRenderNode(fileTree: FileTreeLike): void {
    const original = fileTree.renderNode
    const self = this
    fileTree.renderNode = function hooked(this: unknown, node: TreeNodeData, ...args: unknown[]) {
      try {
        if (self.attached && node && node.isDirectory) self.spliceDir(node)
      } catch (err) {
        console.warn('[tpl:code-viewer] spliceDir failed', err)
      }
      return original.call(this, node, ...args)
    }
    this.restores.push(() => { fileTree.renderNode = original })
  }

  private hookOnChange(fileTree: FileTreeLike): void {
    const original = fileTree.onChangeForMac
    const self = this
    fileTree.onChangeForMac = function hooked(this: unknown, events: DirWatchEvent[]) {
      const result = original.call(this, events)
      try {
        self.onFsEvents(events)
      } catch (err) {
        console.warn('[tpl:code-viewer] fs event handling failed', err)
      }
      return result
    }
    this.restores.push(() => { fileTree.onChangeForMac = original })
  }

  private onFsEvents(events: DirWatchEvent[]): void {
    if (!this.attached) return
    for (const evt of events) {
      for (const p of [evt.path, evt.oldPath]) {
        if (!p || !p.startsWith(this.scanRoot)) continue
        const name = p.split('/').pop() || ''
        const parent = p.slice(0, p.length - name.length - 1)
        if (parent) this.pendingDirs.add(parent)
      }
      // A removed (or renamed-away) directory must not leave ghost entries in
      // the cache; drop every key at or under it.
      if (evt.type === 'removed' || (evt.type === 'rename' && evt.oldPath)) {
        const gone = evt.type === 'removed' ? evt.path : evt.oldPath!
        for (const key of [...this.cache.keys()]) {
          if (key === gone || key.startsWith(`${gone}/`)) this.cache.delete(key)
        }
      }
      // A created directory: rescan it too, so its files appear on first expand.
      if (evt.isDir && evt.type === 'created') this.pendingDirs.add(evt.path)
    }
    if (!this.pendingDirs.size) return
    window.clearTimeout(this.rescanTimer)
    const fileTree = this.fileTree()
    if (!fileTree) return
    this.rescanTimer = window.setTimeout(() => void this.rescanDirs(fileTree), 700)
  }

  // ------------------------------------------------------------- injection

  /** Splice our entries into a directory node's content before it renders. */
  private spliceDir(node: TreeNodeData): void {
    const desired = this.cache.get(node.path)
    if (!desired) return
    const content = (node.content = node.content || [])

    const wanted = new Set(desired.map(item => item.path))
    for (let i = content.length - 1; i >= 0; i -= 1) {
      const item = content[i]!
      if (item.__cv && !wanted.has(item.path)) content.splice(i, 1)
    }
    for (const item of desired) {
      if (!content.some(existing => existing.path === item.path)) {
        content.push({ ...item, __cv: true })
      }
    }
  }

  private repaintDir(fileTree: FileTreeLike, dirPath: string): void {
    const node = this.findNode(fileTree, dirPath)
    if (!node) return
    try {
      const el = fileTree.findElemFromPath(dirPath)
      const fresh = fileTree.renderNode(node)
      if (el && el.length && fresh) el.replaceWith(fresh)
    } catch (err) {
      console.warn('[tpl:code-viewer] repaint failed', dirPath, err)
    }
  }

  /** Repaint the tree's current root (which recursively re-renders open dirs). */
  private repaintVisible(fileTree: FileTreeLike): void {
    const root = fileTree.getRoot?.()
    if (root?.path) this.repaintDir(fileTree, root.path)
  }

  // ---------------------------------------------------------------- opening

  private installClickInterceptor(): void {
    const tree = document.getElementById('file-library-tree')
    if (!tree) return
    tree.addEventListener('click', this.onTreeClick, true)
    this.treeEl = tree as HTMLElement
  }

  private isOurs(path: string): boolean {
    const name = path.split('/').pop() || ''
    if (!name || name.startsWith('.')) return false
    if (languageFor(name) === null) return false
    const dir = path.slice(0, path.length - name.length - 1)
    return (this.cache.get(dir) || []).some(item => item.path === path)
  }
}
