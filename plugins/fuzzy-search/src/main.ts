import { Plugin, editor, platform, IS_MAC } from '@typora-plugin-lite/core'

interface FileEntry {
  absPath: string
  relPath: string
  basename: string
}

const MD_EXTS = new Set(['.md', '.markdown'])
const MAX_MRU = 30
const HOTKEY = 'Mod+.'
const DEBOUNCE_MS = 200

// ---------------------------------------------------------------------------
// FZF-inspired scoring
// Bonuses: consecutive chars, word boundaries (/ - _ . space), basename prefix
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
    if (pos === 0) score += 12
    prevPos = pos
  }

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
  /** MRU files that actually exist + sibling .md files */
  private localFiles: FileEntry[] = []
  private filtered: FileEntry[] = []
  private selectedIdx = 0
  private modalCleanups: Array<() => void> = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  onload(): void {
    this.registerHotkey(HOTKEY, () => this.open())
  }

  onunload(): void {
    this.close()
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
  // Get current directory & root
  // -------------------------------------------------------------------------
  private getCurrentDir(): string {
    const filePath = editor.getFilePath()
    return filePath ? platform.path.dirname(filePath) : ''
  }

  private getRootDir(): string {
    return editor.getWatchedFolder() ?? this.getCurrentDir()
  }

  // -------------------------------------------------------------------------
  // Load files: MRU + siblings (instant, no deep scan)
  // -------------------------------------------------------------------------
  private async loadFiles(): Promise<void> {
    const root = this.getRootDir()
    const currentDir = this.getCurrentDir()
    const seen = new Set<string>()
    this.localFiles = []

    // 1. MRU files (already have full paths)
    const mru = this.getMru()
    for (const absPath of mru) {
      if (seen.has(absPath)) continue
      seen.add(absPath)
      const basename = platform.path.basename(absPath)
      const relPath = root && absPath.startsWith(root)
        ? absPath.slice(root.length).replace(/^\//, '')
        : absPath
      this.localFiles.push({ absPath, relPath, basename })
    }

    // 2. Sibling .md files from current file's directory
    if (currentDir) {
      try {
        const entries = await platform.fs.list(currentDir)
        for (const name of entries) {
          if (name.startsWith('.')) continue
          const ext = platform.path.extname(name).toLowerCase()
          if (!MD_EXTS.has(ext)) continue
          const absPath = platform.path.join(currentDir, name)
          if (seen.has(absPath)) continue
          seen.add(absPath)
          const relPath = root && absPath.startsWith(root)
            ? absPath.slice(root.length).replace(/^\//, '')
            : name
          this.localFiles.push({ absPath, relPath, basename: name })
        }
      } catch (err) {
        console.warn('[tpl:quick-open] failed to list current dir:', err)
      }
    }

    const dir = currentDir || root || '(无)'
    this.updateFooter(`${this.localFiles.length} 个文件  ·  ${dir}`)
  }

  // -------------------------------------------------------------------------
  // Modal open / close
  // -------------------------------------------------------------------------
  private async open(): Promise<void> {
    if (this.overlay) { this.close(); return }
    this.buildModal()
    await this.loadFiles()
    if (this.overlay) {
      this.renderList('')
    }
  }

  private close(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
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

    const inputRow = document.createElement('div')
    inputRow.id = 'tpl-qo-input-row'
    const icon = document.createElement('span')
    icon.id = 'tpl-qo-icon'
    icon.textContent = '\u2315'
    const input = document.createElement('input')
    input.id = 'tpl-qo-input'
    input.type = 'text'
    input.placeholder = '输入文件名搜索...'
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
      // Debounce to avoid excess re-renders while typing fast
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
    list.innerHTML = ''

    if (!this.localFiles.length) {
      list.appendChild(this.makeStatus('未找到 Markdown 文件'))
      return
    }

    if (query.trim()) {
      // --- Query mode: FZF scoring ---
      const results = this.localFiles
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
      // --- No query: MRU first, then siblings ---
      const mru = this.getMru()
      const mruSet = new Set(mru)
      const fileMap = new Map(this.localFiles.map(f => [f.absPath, f]))

      const mruFiles = mru
        .map(p => fileMap.get(p))
        .filter((f): f is FileEntry => !!f)
        .slice(0, 15)

      const siblingFiles = this.localFiles
        .filter(f => !mruSet.has(f.absPath))
        .slice(0, 35)

      this.filtered = [...mruFiles, ...siblingFiles]
      this.selectedIdx = 0

      if (mruFiles.length) {
        list.appendChild(this.makeSectionLabel('最近打开'))
        mruFiles.forEach((f, i) => list.appendChild(this.makeItem(f, i)))
      }
      if (siblingFiles.length) {
        list.appendChild(this.makeSectionLabel(mruFiles.length ? '当前目录' : '文件'))
        siblingFiles.forEach((f, i) => list.appendChild(this.makeItem(f, mruFiles.length + i)))
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
