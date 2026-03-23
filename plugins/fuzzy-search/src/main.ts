import { Plugin, editor, platform } from '@typora-plugin-lite/core'

interface FileEntry {
  absPath: string
  relPath: string
  basename: string
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache', '.DS_Store'])
const MD_EXTS = new Set(['.md', '.markdown'])
const MAX_DEPTH = 6
const MAX_FILES = 2000
const HOTKEY = 'Mod+.'

/** Fuzzy match score. Returns -1 if no match, higher = better. */
function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 0
  if (t === q) return 1000
  if (t.startsWith(q)) return 900
  const subIdx = t.indexOf(q)
  if (subIdx >= 0) return 700 - subIdx
  // Subsequence check
  let ti = 0
  let qi = 0
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) qi++
    ti++
  }
  if (qi < q.length) return -1
  // Score: prefer tighter matches
  return 200 - ti
}

const CSS = `
#tpl-qo-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  z-index: 99998;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
}
#tpl-qo-modal {
  background: var(--bg-color, #fff);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.35);
  width: 580px;
  max-width: 92vw;
  overflow: hidden;
  border: 1px solid var(--border-color, rgba(128,128,128,0.2));
}
#tpl-qo-input-row {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  gap: 10px;
  border-bottom: 1px solid var(--border-color, rgba(128,128,128,0.15));
}
#tpl-qo-icon {
  font-size: 18px;
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
  max-height: 360px;
  overflow-y: auto;
  padding: 4px 0;
}
.tpl-qo-item {
  padding: 7px 16px;
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
  opacity: 0.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tpl-qo-status {
  padding: 14px 16px;
  font-size: 13px;
  color: var(--text-color, #888);
  opacity: 0.55;
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
  private modalCleanups: Array<() => void> = []

  onload(): void {
    this.registerHotkey(HOTKEY, () => this.open())
  }

  onunload(): void {
    this.close()
  }

  private async open(): Promise<void> {
    if (this.overlay) {
      this.close()
      return
    }
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

  private buildModal(): void {
    // Inject styles once (removed on plugin unload via addDisposable)
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
    icon.textContent = '⌕'

    const input = document.createElement('input')
    input.id = 'tpl-qo-input'
    input.type = 'text'
    input.placeholder = '搜索文件...'
    input.autocomplete = 'off'
    input.spellcheck = false

    inputRow.appendChild(icon)
    inputRow.appendChild(input)

    const list = document.createElement('div')
    list.id = 'tpl-qo-list'

    modal.appendChild(inputRow)
    modal.appendChild(list)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    this.overlay = overlay
    this.inputEl = input
    this.listEl = list

    const onInput = () => this.renderList(input.value)
    const onKeydown = (e: KeyboardEvent) => this.handleKey(e)
    const onDocKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.close()
      }
    }

    input.addEventListener('input', onInput)
    input.addEventListener('keydown', onKeydown)
    document.addEventListener('keydown', onDocKeydown, { capture: true })

    this.modalCleanups.push(
      () => input.removeEventListener('input', onInput),
      () => input.removeEventListener('keydown', onKeydown),
      () => document.removeEventListener('keydown', onDocKeydown, { capture: true }),
    )

    // Show scanning placeholder immediately
    this.scanning = true
    this.renderList('')

    setTimeout(() => input.focus(), 30)
  }

  private async scan(): Promise<void> {
    const filePath = editor.getFilePath()
    const root = editor.getWatchedFolder()
      || (filePath ? platform.path.dirname(filePath) : '')
    if (!root) {
      this.scanning = false
      return
    }
    this.allFiles = []
    try {
      await this.scanDir(root, root, MAX_DEPTH)
    } catch (err) {
      console.error('[tpl:quick-open] scan error:', err)
    } finally {
      this.scanning = false
    }
  }

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
        } else {
          const ext = platform.path.extname(name).toLowerCase()
          if (MD_EXTS.has(ext)) {
            const relPath = absPath.slice(root.length).replace(/^[/\\]/, '')
            this.allFiles.push({ absPath, relPath, basename: name })
          }
        }
      } catch {}
    }
    await Promise.all(subdirs.map(sd => this.scanDir(sd, root, depth - 1)))
  }

  private renderList(query: string): void {
    const list = this.listEl
    if (!list) return
    list.innerHTML = ''

    if (this.scanning) {
      list.appendChild(this.makeStatus('正在扫描文件...'))
      return
    }

    if (!this.allFiles.length) {
      list.appendChild(this.makeStatus('未找到文件（请先在 Typora 中打开一个文件夹）'))
      return
    }

    if (query) {
      const scored = this.allFiles
        .map(f => ({
          f,
          s: Math.max(
            fuzzyScore(f.basename, query),
            fuzzyScore(f.relPath, query) - 30,
          ),
        }))
        .filter(x => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
      this.filtered = scored.map(x => x.f)
    } else {
      this.filtered = this.allFiles.slice(0, 50)
    }

    if (!this.filtered.length) {
      list.appendChild(this.makeStatus('没有匹配的文件'))
      return
    }

    this.selectedIdx = 0
    this.filtered.forEach((f, i) => {
      const item = document.createElement('div')
      item.className = 'tpl-qo-item' + (i === 0 ? ' tpl-qo-selected' : '')

      const name = document.createElement('div')
      name.className = 'tpl-qo-name'
      name.textContent = f.basename

      const pathEl = document.createElement('div')
      pathEl.className = 'tpl-qo-path'
      pathEl.textContent = f.relPath

      item.appendChild(name)
      item.appendChild(pathEl)
      item.addEventListener('mouseenter', () => {
        this.selectedIdx = i
        this.highlight()
      })
      item.addEventListener('click', () => this.openSelected())
      list.appendChild(item)
    })
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
    editor.openFile(f.absPath).catch(err => {
      this.showNotice(`打开文件失败: ${err.message}`)
    })
  }
}
