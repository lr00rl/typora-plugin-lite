/**
 * NotePalette: the keyboard-first related-notes surface.
 *
 * Interaction model mirrors the Quick Open plugin (fuzzy-search) so the two
 * palettes feel like one product: a single indexed row array with one
 * selectedIdx, an IME-guarded key handler on the input, roving-tabindex scope
 * tabs, aria-activedescendant rather than focus movement, and close-before-act
 * so Enter/⌥Enter land in a restored editor context.
 */

import { IS_MAC, editor } from '@typora-plugin-lite/core'

import type { GraphStore } from './graph.js'
import { deriveTitleFromTarget } from './links.js'
import {
  SCOPE_LABELS,
  SCOPE_ORDER,
  deriveScopeRows,
  filterRows,
  type FilteredRow,
  type PaletteRow,
  type PaletteScope,
} from './rows.js'

const ROW_DISPLAY_CAP = 100
const ENTER_REENTRY_MS = 180
const STALE_DAYS = 7

export class NotePalette {
  private overlay: HTMLDivElement | null = null
  private inputEl: HTMLInputElement | null = null
  private listEl: HTMLDivElement | null = null
  private tabBarEl: HTMLDivElement | null = null
  private footerTextEl: HTMLDivElement | null = null
  private footerActionEl: HTMLButtonElement | null = null
  private restoreFocusEl: HTMLElement | null = null

  private scope: PaletteScope = 'related'
  private query = ''
  private rows: FilteredRow[] = []
  private selectedIdx = 0
  private composing = false
  private renderToken = 0
  private lastEnterAt = 0
  private rebuildFailed = false
  private cleanups: Array<() => void> = []

  constructor(
    private store: GraphStore,
    private notify: (message: string) => void,
  ) {}

  get isOpen(): boolean {
    return !!this.overlay
  }

  async toggle(): Promise<void> {
    if (this.overlay) {
      this.close()
      return
    }
    await this.open()
  }

  private async open(): Promise<void> {
    this.restoreFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.query = ''
    this.buildModal()
    await this.store.load()
    if (!this.overlay) return
    // Open on the richest scope: 相关 is the curated answer but is empty for
    // notes the decision stage skipped; 链接 and 候选 still carry real signal.
    // The tab bar always shows which scope is active, so this stays learnable.
    this.scope = this.pickInitialScope()
    this.updateTabState()
    this.refreshRows()
    this.updateFooter()
    window.setTimeout(() => this.inputEl?.focus(), 30)
  }

  private pickInitialScope(): PaletteScope {
    const current = this.store.currentNote()
    for (const scope of SCOPE_ORDER) {
      const rows = deriveScopeRows(current?.note ?? null, scope, {
        noteMap: this.store.noteMap,
        currentFile: current?.currentFile ?? '',
        rootDir: this.store.graphRoot,
      })
      if (rows.length) return scope
    }
    return 'related'
  }

  close(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.overlay?.remove()
    this.overlay = null
    this.inputEl = null
    this.listEl = null
    this.tabBarEl = null
    this.footerTextEl = null
    this.footerActionEl = null
    this.rows = []
    this.selectedIdx = 0
    this.composing = false
    const restore = this.restoreFocusEl
    this.restoreFocusEl = null
    if (restore?.isConnected) restore.focus()
  }

  dispose(): void {
    this.close()
  }

  private buildModal(): void {
    const overlay = document.createElement('div')
    overlay.id = 'tpl-na-overlay'
    overlay.addEventListener('mousedown', evt => {
      if (evt.target === overlay) this.close()
    })

    const modal = document.createElement('div')
    modal.id = 'tpl-na-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-labelledby', 'tpl-na-title')

    const title = document.createElement('h2')
    title.id = 'tpl-na-title'
    title.className = 'tpl-na-sr-only'
    title.textContent = '相关笔记'

    const inputRow = document.createElement('div')
    inputRow.id = 'tpl-na-input-row'

    const input = document.createElement('input')
    input.id = 'tpl-na-input'
    input.type = 'text'
    input.placeholder = '过滤相关笔记…'
    input.spellcheck = false
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-label', '过滤相关笔记')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-haspopup', 'listbox')
    input.setAttribute('aria-controls', 'tpl-na-list')
    input.setAttribute('aria-expanded', 'true')

    const tabBar = document.createElement('div')
    tabBar.id = 'tpl-na-tab-bar'
    tabBar.setAttribute('role', 'tablist')
    tabBar.setAttribute('aria-label', '范围')

    inputRow.appendChild(input)
    inputRow.appendChild(tabBar)

    const list = document.createElement('div')
    list.id = 'tpl-na-list'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', '相关笔记结果')

    const footer = document.createElement('div')
    footer.id = 'tpl-na-footer'
    const footerText = document.createElement('div')
    footerText.id = 'tpl-na-footer-text'
    footerText.setAttribute('role', 'status')
    footerText.setAttribute('aria-live', 'polite')
    const footerRight = document.createElement('div')
    footerRight.style.display = 'flex'
    footerRight.style.alignItems = 'center'
    const hints = document.createElement('div')
    hints.id = 'tpl-na-footer-hints'
    hints.textContent = IS_MAC
      ? '↑↓ 移动 · Enter 打开 · ⌥Enter 插入链接 · Tab 范围 · Esc 关闭'
      : '↑↓ 移动 · Enter 打开 · Alt+Enter 插入链接 · Tab 范围 · Esc 关闭'
    const footerAction = document.createElement('button')
    footerAction.id = 'tpl-na-footer-action'
    footerAction.type = 'button'
    footerAction.textContent = '重建索引'
    footerAction.hidden = true
    footerAction.addEventListener('click', () => void this.rebuild())
    footerRight.appendChild(footerAction)
    footerRight.appendChild(hints)
    footer.appendChild(footerText)
    footer.appendChild(footerRight)

    modal.appendChild(title)
    modal.appendChild(inputRow)
    modal.appendChild(list)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    this.overlay = overlay
    this.inputEl = input
    this.listEl = list
    this.tabBarEl = tabBar
    this.footerTextEl = footerText
    this.footerActionEl = footerAction

    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      handler: (evt: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, handler as EventListener, options)
      this.cleanups.push(() => el.removeEventListener(type, handler as EventListener, options))
    }

    on(input, 'keydown', evt => this.handleKey(evt))
    on(input, 'input', () => {
      if (this.composing) return
      this.query = input.value
      this.applyFilter()
    })
    on(input, 'compositionstart', () => {
      this.composing = true
    })
    on(input, 'compositionend', () => {
      this.composing = false
      this.query = input.value
      this.applyFilter()
    })
    on(modal, 'keydown', evt => {
      if (evt.key === 'Tab' && evt.target !== input) {
        // Focus containment: the input consumes Tab for scope cycling; every
        // other control wraps back to the input so focus never leaves the dialog.
        evt.preventDefault()
        input.focus()
      }
      if (evt.key === 'Escape') {
        evt.preventDefault()
        this.close()
      }
    })

    this.renderTabs()
  }

  private renderTabs(): void {
    if (!this.tabBarEl) return
    this.tabBarEl.textContent = ''
    for (const scope of SCOPE_ORDER) {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'tpl-na-tab'
      tab.id = `tpl-na-tab-${scope}`
      tab.textContent = SCOPE_LABELS[scope]
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-controls', 'tpl-na-list')
      tab.dataset.scope = scope
      tab.addEventListener('click', () => this.setScope(scope))
      tab.addEventListener('mousedown', evt => evt.preventDefault())
      this.tabBarEl.appendChild(tab)
    }
    this.updateTabState()
  }

  private updateTabState(): void {
    if (!this.tabBarEl) return
    for (const tab of Array.from(this.tabBarEl.children) as HTMLElement[]) {
      const active = tab.dataset.scope === this.scope
      tab.classList.toggle('tpl-na-tab-active', active)
      tab.setAttribute('aria-selected', String(active))
      // Tabs are a pointer affordance and scope indicator; the keyboard path
      // is Tab / Cmd+arrows from the always-focused input, so tabs never take
      // keyboard focus themselves.
      tab.tabIndex = -1
    }
  }

  private setScope(scope: PaletteScope): void {
    if (scope === this.scope) return
    this.scope = scope
    this.selectedIdx = 0
    this.updateTabState()
    this.refreshRows()
    this.inputEl?.focus()
  }

  private cycleScope(dir: number): void {
    const idx = SCOPE_ORDER.indexOf(this.scope)
    const next = SCOPE_ORDER[(idx + dir + SCOPE_ORDER.length) % SCOPE_ORDER.length]
    this.setScope(next)
  }

  private handleKey(evt: KeyboardEvent): void {
    if (evt.isComposing || evt.keyCode === 229) return
    const mod = evt.metaKey || evt.ctrlKey

    if (mod && (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight')) {
      evt.preventDefault()
      this.cycleScope(evt.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (mod && evt.key.toLowerCase() === 'r') {
      evt.preventDefault()
      if (evt.repeat) return
      void this.rebuild()
      return
    }
    if (evt.key === 'Tab') {
      evt.preventDefault()
      this.cycleScope(evt.shiftKey ? -1 : 1)
      return
    }
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
      evt.preventDefault()
      if (!this.rows.length) return
      // Clamp to the rendered window, not the full filtered set: rows past the
      // display cap are reachable by typing a narrower query, not by walking
      // the selection into unrendered space.
      const maxIdx = Math.min(this.rows.length, ROW_DISPLAY_CAP) - 1
      const delta = evt.key === 'ArrowDown' ? 1 : -1
      this.selectedIdx = Math.max(0, Math.min(this.selectedIdx + delta, maxIdx))
      this.highlight()
      return
    }
    if (evt.key === 'Enter') {
      evt.preventDefault()
      if (evt.repeat) return
      const now = Date.now()
      if (now - this.lastEnterAt < ENTER_REENTRY_MS) return
      this.lastEnterAt = now
      const row = this.rows[this.selectedIdx]?.row
      if (!row) return
      if (evt.altKey) void this.activateInsert(row)
      else void this.activateOpen(row)
      return
    }
    if (evt.key === 'Escape') {
      evt.preventDefault()
      this.close()
    }
  }

  /** Reload the graph (mtime-cached) and re-render everything. */
  async refresh(): Promise<void> {
    const token = ++this.renderToken
    await this.store.load()
    if (!this.overlay || token !== this.renderToken) return
    this.refreshRows()
    this.updateFooter()
  }

  private refreshRows(): void {
    const current = this.store.currentNote()
    const rows = deriveScopeRows(current?.note ?? null, this.scope, {
      noteMap: this.store.noteMap,
      currentFile: current?.currentFile ?? '',
      rootDir: this.store.graphRoot,
    })
    this.allRows = rows
    this.applyFilter()
  }

  private allRows: PaletteRow[] = []

  private applyFilter(): void {
    this.rows = filterRows(this.allRows, this.query)
    this.selectedIdx = 0
    this.renderList()
  }

  private statusState(): { kind: 'no-file' | 'no-graph' | 'not-indexed' | 'empty-scope' | 'no-match' | 'ok'; message?: string } {
    const current = this.store.currentNote()
    if (!current?.currentFile) return { kind: 'no-file', message: '没有打开的文件。' }
    if (!this.store.graphPath) return { kind: 'no-graph', message: '还没有相关索引。' }
    if (!current.note) return { kind: 'not-indexed', message: '本篇不在索引中。' }
    if (!this.allRows.length) {
      const message = this.scope === 'links' ? '本篇没有出链与入链。' : '当前范围暂无条目。'
      return { kind: 'empty-scope', message }
    }
    if (!this.rows.length) return { kind: 'no-match', message: '无匹配结果。' }
    return { kind: 'ok' }
  }

  private renderList(): void {
    if (!this.listEl) return
    this.listEl.textContent = ''

    const state = this.statusState()
    if (state.kind !== 'ok') {
      const status = document.createElement('div')
      status.className = 'tpl-na-status'
      status.setAttribute('role', 'status')
      if (state.kind === 'no-graph') {
        status.textContent = '还没有相关索引，重建一次索引即可生成。'
      } else if (state.kind === 'not-indexed') {
        status.textContent = '本篇不在索引中。保存后重建索引即可收录。'
      } else {
        status.textContent = state.message || ''
      }
      this.listEl.appendChild(status)
      this.inputEl?.removeAttribute('aria-activedescendant')
      return
    }

    const visible = this.rows.slice(0, ROW_DISPLAY_CAP)
    visible.forEach((filtered, idx) => {
      this.listEl!.appendChild(this.makeRow(filtered, idx))
    })
    if (this.rows.length > ROW_DISPLAY_CAP) {
      const note = document.createElement('div')
      note.className = 'tpl-na-overflow-note'
      note.textContent = `共 ${this.rows.length} 条，输入以过滤`
      this.listEl.appendChild(note)
    }
    this.highlight()
  }

  private makeRow(filtered: FilteredRow, idx: number): HTMLDivElement {
    const { row, titlePositions, pathPositions } = filtered
    const el = document.createElement('div')
    el.className = 'tpl-na-item'
    el.id = `tpl-na-option-${idx}`
    el.setAttribute('role', 'option')
    el.setAttribute('aria-selected', 'false')
    el.tabIndex = -1
    el.title = row.relPath

    const name = document.createElement('div')
    name.className = 'tpl-na-name'
    renderHighlightedText(name, row.title, titlePositions)

    el.appendChild(name)

    if (row.badge) {
      const badge = document.createElement('div')
      badge.className = 'tpl-na-badge'
      badge.textContent = row.badge
      el.appendChild(badge)
    } else {
      const spacer = document.createElement('div')
      el.appendChild(spacer)
    }

    const path = document.createElement('div')
    path.className = 'tpl-na-path'
    renderHighlightedText(path, row.relPath, pathPositions)
    el.appendChild(path)

    el.addEventListener('mouseenter', () => {
      if (this.selectedIdx === idx) return
      this.selectedIdx = idx
      this.highlight()
    })
    el.addEventListener('mousedown', evt => evt.preventDefault())
    el.addEventListener('click', () => void this.activateOpen(row))
    return el
  }

  private highlight(): void {
    if (!this.listEl || !this.inputEl) return
    const items = Array.from(this.listEl.querySelectorAll<HTMLElement>('.tpl-na-item'))
    items.forEach((el, idx) => {
      const selected = idx === this.selectedIdx
      el.classList.toggle('tpl-na-selected', selected)
      el.setAttribute('aria-selected', String(selected))
      if (selected) {
        this.inputEl!.setAttribute('aria-activedescendant', el.id)
        el.scrollIntoView({ block: 'nearest' })
      }
    })
  }

  private async activateOpen(row: PaletteRow): Promise<void> {
    const currentFile = this.store.currentNote()?.currentFile ?? ''
    const relPath = row.relPath
    this.close()
    try {
      const hit = await this.store.resolveNoteTarget(relPath, currentFile)
      if (!hit.absPath) {
        if (hit.basenameMatches > 1) {
          this.notify(`「${row.title}」有 ${hit.basenameMatches} 篇同名笔记，无法确定目标`)
        } else {
          this.notify(`找不到：${relPath}。可能已移动或删除；Cmd+Shift+R 重建索引试试`)
        }
        return
      }
      await editor.openFile(hit.absPath)
      if (hit.via === 'basename') {
        this.notify('已按文件名解析到新位置（原路径已失效，重建索引后自愈）')
      }
    } catch (err) {
      console.error('[tpl:note-assistant] open failed', err)
      this.notify(`无法打开：${relPath}`)
    }
  }

  private async activateInsert(row: PaletteRow): Promise<void> {
    if (!this.store.currentNote()?.currentFile) {
      this.notify('没有打开的文件')
      return
    }
    // Wiki syntax metacharacters in a title would truncate the link's display
    // text (the vault parser's character classes exclude them), so soften them.
    const title = row.title.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim()
      || deriveTitleFromTarget(row.target)
    const text = `[[${row.target}|${title}]]`
    this.close()
    if (!insertAtCaret(text)) {
      this.notify('源代码模式不可用，请切换后重试')
      return
    }
    this.notify('已插入链接 · 保存并重建索引后生效')
  }

  async rebuild(): Promise<boolean> {
    if (this.store.rebuildInFlight) return false
    this.rebuildFailed = false
    // store.rebuild() flips rebuildInFlight synchronously (before its first
    // await), so the footer below renders the in-flight state truthfully.
    const pending = this.store.rebuild()
    this.updateFooter()
    const ok = await pending
    this.rebuildFailed = !ok
    this.notify(ok ? '索引已重建' : '索引重建失败')
    if (this.overlay) {
      await this.refresh()
    } else {
      this.updateFooter()
    }
    return ok
  }

  private updateFooter(): void {
    if (!this.footerTextEl || !this.footerActionEl) return
    const text = this.footerTextEl
    const action = this.footerActionEl

    if (this.store.rebuildInFlight) {
      text.textContent = '正在重建索引…'
      action.hidden = false
      action.disabled = true
      action.textContent = '重建中…'
      return
    }

    action.disabled = false
    action.textContent = this.rebuildFailed ? '重试重建' : '重建索引'

    if (this.rebuildFailed) {
      text.textContent = '索引重建失败。'
      action.hidden = false
      return
    }
    if (!this.store.graphPath) {
      text.textContent = '未找到 .note-assistant/graph.json'
      action.hidden = false
      return
    }

    const graph = this.store
    const generated = graph.generatedAt ? formatDate(graph.generatedAt) : '未知时间'
    const total = graph.totalNotes
    const stale = graph.generatedAt
      ? (Date.now() - Date.parse(graph.generatedAt)) > STALE_DAYS * 86_400_000
      : false
    const current = this.store.currentNote()
    const indexedPrefix = current?.note ? '' : '本篇未索引 · '
    text.textContent = `${indexedPrefix}共 ${total} 篇 · 生成于 ${generated}`
    action.hidden = !stale && !!current?.note
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${mm}-${dd}`
}

/** Insert text at the caret in whichever edit mode is active. */
function insertAtCaret(text: string): boolean {
  const sourceView = (window as any).File?.editor?.sourceView
  if (sourceView?.inSourceMode) {
    const cm = sourceView.cm as { replaceSelection?: (value: string) => void } | undefined
    if (typeof cm?.replaceSelection !== 'function') return false
    cm.replaceSelection(text)
    return true
  }
  editor.insertText(text)
  return true
}

/** Quiet highlight: matched runs become underline-tinted marks, no fill block. */
function renderHighlightedText(el: HTMLElement, text: string, positions: number[] | null): void {
  if (!positions || !positions.length) {
    el.textContent = text
    return
  }
  const wanted = new Set(positions)
  let buffer = ''
  let inHit = false
  const flush = () => {
    if (!buffer) return
    if (inHit) {
      const mark = document.createElement('mark')
      mark.className = 'tpl-na-hit'
      mark.textContent = buffer
      el.appendChild(mark)
    } else {
      el.appendChild(document.createTextNode(buffer))
    }
    buffer = ''
  }
  for (let i = 0; i < text.length; i++) {
    const hit = wanted.has(i)
    if (hit !== inHit) {
      flush()
      inHit = hit
    }
    buffer += text[i]
  }
  flush()
}
