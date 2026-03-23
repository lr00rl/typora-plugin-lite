import { Plugin, editor, platform, IS_MAC } from '@typora-plugin-lite/core'

interface FileEntry {
  absPath: string
  relPath: string
  basename: string
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache', '.svn', '.hg'])
const MD_EXTS = new Set(['.md', '.markdown'])
const MAX_DEPTH = 10
const MAX_FILES = 8000
const MAX_MRU = 30
const HOTKEY = 'Mod+.'

// ---------------------------------------------------------------------------
// FZF-inspired scoring
// Bonuses: consecutive chars, word boundaries (/ - _ . space), basename prefix
// ---------------------------------------------------------------------------
function fzfScore(text: string, query: string): number {
  const t = text.toLowerCase()
  const q = query.toLowerCase()

  // Greedy forward subsequence match
  const positions: number[] = []
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) { positions.push(ti); qi++ }
  }
  if (qi < q.length) return -Infinity  // no match

  let score = 100
  let prevPos = -2
  let consecutive = 0

  for (const pos of positions) {
    // Consecutive run bonus (escalates like fzf)
    if (pos === prevPos + 1) {
      consecutive++
      score += consecutive * 6
    } else {
      consecutive = 0
    }

    // Word boundary bonus
    const prevCh = pos > 0 ? t[pos - 1] : ''
    if (pos === 0 || /[\\/\-_.\s]/.test(prevCh)) score += 10
    if (pos === 0) score += 12  // leading-char bonus

    prevPos = pos
  }

  // Tighter match = less penalty
  const span = positions[positions.length - 1] - positions[0] + 1
  score -= span * 0.4
  score -= (t.length - q.length) * 0.1

  return score
}

function scoreFile(f: FileEntry, query: string): number {
  // Basename match is worth more than full-path match
  const nameScore = fzfScore(f.basename, query) + 25
  const pathScore = fzfScore(f.relPath, query)
  return Math.max(nameScore, pathScore)
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
  private allFiles: FileEntry[] = []
  private filtered: FileEntry[] = []
  private selectedIdx = 0
  private scanning = false
  private scanRoot = ''
  private modalCleanups: Array<() => void> = []

  onload(): void {
    this.registerHotkey(HOTKEY, () => this.open())
  }

  onunload(): void {
    this.close()
  }

  // -------------------------------------------------------------------------
  // MRU helpers  (stored in plugin settings as plain string[])
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
  // Determine the workspace root to scan from.
  // Priority: watchedFolder (sidebar) → current file's dirname
  // -------------------------------------------------------------------------
  private getRootDir(): string {
    const watched = (window as any).File?.editor?.library?.watchedFolder
    if (watched && typeof watched === 'string') return watched

    const filePath = editor.getFilePath()
    return filePath ? platform.path.dirname(filePath) : ''
  }

  // -------------------------------------------------------------------------
  // Modal open / close
  // -------------------------------------------------------------------------
  private async open(): Promise<void> {
    if (this.overlay) { this.close(); return }
    this.buildModal()
    await this.scan()
    if (this.overlay) {
      this.renderList(this.inputEl?.value ?? '')
    }
  }

  private close(): void {
    for (const fn of this.modalCleanups) fn()
    this.modalCleanups = []
    this.overlay?.remove()
    this.overlay = null
    this.inputEl = null
    this.listEl = null
    this.filtered = []
    this.selectedIdx = 0
  }

  // -------------------------------------------------------------------------
  // Build DOM
  // -------------------------------------------------------------------------
  private buildModal(): void {
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

    // Input row
    const inputRow = document.createElement('div')
    inputRow.id = 'tpl-qo-input-row'
    const icon = document.createElement('span')
    icon.id = 'tpl-qo-icon'
    icon.textContent = '⌕'
    const input = document.createElement('input')
    input.id = 'tpl-qo-input'
    input.type = 'text'
    input.placeholder = '输入文件名...'
    input.autocomplete = 'off'
    input.spellcheck = false
    inputRow.appendChild(icon)
    inputRow.appendChild(input)

    // List
    const list = document.createElement('div')
    list.id = 'tpl-qo-list'

    // Footer
    const footer = document.createElement('div')
    footer.id = 'tpl-qo-footer'
    footer.textContent = '正在扫描...'

    modal.appendChild(inputRow)
    modal.appendChild(list)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    this.overlay = overlay
    this.inputEl = input
    this.listEl = list

    // Event wiring
    const onInput = () => this.renderList(input.value)
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

    this.scanning = true
    this.renderList('')
    setTimeout(() => input.focus(), 30)
  }

  private updateFooter(text: string): void {
    const el = this.overlay?.querySelector('#tpl-qo-footer')
    if (el) el.textContent = text
  }

  // -------------------------------------------------------------------------
  // File scanning
  // -------------------------------------------------------------------------
  private async scan(): Promise<void> {
    const root = this.getRootDir()
    if (!root) {
      this.scanning = false
      this.updateFooter('未找到工作目录，请先在 Typora 中打开一个文件夹')
      return
    }
    this.scanRoot = root
    this.allFiles = []
    try {
      if (IS_MAC) {
        await this.scanWithFind(root)
      } else {
        await this.scanDir(root, root, MAX_DEPTH)
      }
    } catch (err) {
      console.error('[tpl:quick-open] scan error:', err)
    } finally {
      this.scanning = false
      this.updateFooter(`${this.allFiles.length} 个文件  ·  ${root}`)
    }
  }

  /** macOS: single `find` call — avoids per-entry stat() and BSD stat format issues. */
  private async scanWithFind(root: string): Promise<void> {
    const escaped = platform.shell.escape(root)
    // Build -path prune expressions for skipped dirs
    const pruneExpr = [...SKIP_DIRS]
      .map(d => `-path ${platform.shell.escape('*/' + d)} -prune`)
      .join(' -o ')
    const cmd = [
      `find ${escaped}`,
      `\\( ${pruneExpr} \\)`,
      `-o -type f \\( -iname '*.md' -o -iname '*.markdown' \\) -print`,
    ].join(' ')

    const output = await platform.shell.run(cmd, { timeout: 30_000 })
    const lines = output.trim().split('\n').filter(Boolean)
    for (const absPath of lines) {
      if (this.allFiles.length >= MAX_FILES) break
      const relPath = absPath.slice(root.length).replace(/^\//, '')
      const basename = platform.path.basename(absPath)
      this.allFiles.push({ absPath, relPath, basename })
    }
  }

  /** Win/Linux: recursive scan via Node.js fs (stat works correctly there). */
  private async scanDir(dir: string, root: string, depth: number): Promise<void> {
    if (depth <= 0 || this.allFiles.length >= MAX_FILES) return
    let entries: string[]
    try {
      entries = await platform.fs.list(dir)
    } catch {
      return
    }
    const subdirs: string[] = []
    for (const name of entries) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
      const absPath = platform.path.join(dir, name)
      try {
        const stat = await platform.fs.stat(absPath)
        if (stat.isDirectory()) {
          subdirs.push(absPath)
        } else if (MD_EXTS.has(platform.path.extname(name).toLowerCase())) {
          const relPath = absPath.slice(root.length).replace(/^[/\\]/, '')
          this.allFiles.push({ absPath, relPath, basename: name })
        }
      } catch {}
    }
    await Promise.all(subdirs.map(sd => this.scanDir(sd, root, depth - 1)))
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  private renderList(query: string): void {
    const list = this.listEl
    if (!list) return
    list.innerHTML = ''

    if (this.scanning) {
      list.appendChild(this.makeStatus('正在扫描文件...'))
      return
    }
    if (!this.allFiles.length) {
      list.appendChild(this.makeStatus('未找到 Markdown 文件'))
      return
    }

    if (query.trim()) {
      // --- Query mode: FZF scoring ---
      const results = this.allFiles
        .map(f => ({ f, s: scoreFile(f, query) }))
        .filter(x => x.s > -Infinity)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
      this.filtered = results.map(x => x.f)

      if (!this.filtered.length) {
        list.appendChild(this.makeStatus('没有匹配的文件'))
        return
      }
      this.selectedIdx = 0
      this.filtered.forEach((f, i) => list.appendChild(this.makeItem(f, i)))
    } else {
      // --- No query: MRU first, then remaining ---
      const mru = this.getMru()
      const mruSet = new Set(mru)
      const fileMap = new Map(this.allFiles.map(f => [f.absPath, f]))

      const mruFiles = mru
        .map(p => fileMap.get(p))
        .filter((f): f is FileEntry => !!f)
        .slice(0, 15)

      const restFiles = this.allFiles
        .filter(f => !mruSet.has(f.absPath))
        .slice(0, 35)

      this.filtered = [...mruFiles, ...restFiles]
      this.selectedIdx = 0

      if (mruFiles.length) {
        list.appendChild(this.makeSectionLabel('最近打开'))
        mruFiles.forEach((f, i) => list.appendChild(this.makeItem(f, i)))
      }
      if (restFiles.length) {
        list.appendChild(this.makeSectionLabel(mruFiles.length ? '所有文件' : '文件'))
        restFiles.forEach((f, i) => list.appendChild(this.makeItem(f, mruFiles.length + i)))
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
    pathEl.textContent = f.relPath

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
    this.close()
    this.recordOpen(f.absPath).catch(() => {})
    editor.openFile(f.absPath).catch(err => {
      this.showNotice(`打开文件失败: ${err.message}`)
    })
  }
}
