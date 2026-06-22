import { IS_MAC, Plugin, editor } from '@typora-plugin-lite/core'
import { shouldMutateLiveSidenoteDom } from './dom-guards.js'
import { getPortalPagePosition } from './portal-geometry.js'
import { SIDENOTE_TAG_CLOSE, formatSidenoteInsertion } from './insertion.js'

const SIDENOTE_RE = /class=["'](?:side|margin)note["']/
const ADD_SIDENOTE_CMD = 'sidenote:add'
const ADD_SIDENOTE_HOTKEY = 'Mod+Alt+S'

interface QuickAction {
  id: string
  label: string
  shortcut?: string
  run: () => void
}

/**
 * Sidenote plugin — Tufte-style margin annotations for Typora.
 *
 * Typora wraps inline HTML in `.md-html-inline` with `.md-meta` tag spans.
 * The actual `<span class="sidenote">` never exists in the editor DOM.
 *
 * This plugin:
 * 1. Finds `.md-html-inline` elements whose opening tag contains "sidenote"
 * 2. Adds `tpl-sidenote` class + inserts a `tpl-sn-num` marker before it
 * 3. Syncs a shared numeric index across the in-text marker, margin note, and table portal
 *
 * DOM insertion is safe — Typora serializes from its markdown source,
 * not from the live DOM (same pattern as fence-enhance's copy button).
 */
export default class SidenotePlugin extends Plugin {
  private observer: MutationObserver | null = null
  private rafId = 0
  private writeEl: HTMLElement | null = null
  private portalLayerEl: HTMLElement | null = null
  private widerTransitionTimer = 0
  private isComposing = false
  private pendingProcess = false
  private quickMenuEl: HTMLDivElement | null = null
  private quickMenuHideTimer = 0
  private savedSelection: unknown | null = null
  private savedSelectionText = ''
  private contextMenuOpeningTimer = 0
  private selectionMenuTimer = 0
  private isContextMenuOpening = false

  onload(): void {
    this.registerCommand({
      id: ADD_SIDENOTE_CMD,
      name: 'Sidenote: Add from Selection',
      callback: () => this.addSidenoteFromSelection(),
    })
    this.registerHotkey(ADD_SIDENOTE_HOTKEY, () => this.addSidenoteFromSelection())

    this.writeEl = document.getElementById('write')
    if (!this.writeEl) return

    this.registerCss(EDITOR_CSS)
    this.ensurePortalLayer()
    this.processAll(this.writeEl)

    this.observer = new MutationObserver((mutations) => {
      const hasEditorMutation = mutations.some((mutation) => !this.isPortalMutation(mutation))
      if (hasEditorMutation) this.scheduleProcess()
    })

    this.observer.observe(this.writeEl, {
      childList: true,
      subtree: true,
    })
    this.registerDomEvent(this.writeEl, 'input', () => this.scheduleProcess())
    this.registerDomEvent(this.writeEl, 'focusin', () => this.scheduleProcess(), { capture: true })
    this.registerDomEvent(this.writeEl, 'focusout', () => this.scheduleProcess(), { capture: true })
    this.registerDomEvent(this.writeEl, 'compositionstart', () => this.handleCompositionStart(), { capture: true })
    this.registerDomEvent(this.writeEl, 'compositionend', () => this.handleCompositionEnd(), { capture: true })
    this.registerDomEvent(this.writeEl, 'mousedown', event => this.handleEditorMouseDown(event as MouseEvent), { capture: true })
    this.registerDomEvent(this.writeEl, 'contextmenu', event => this.handleContextMenu(event as MouseEvent), { capture: true })
    this.registerDomEvent(document, 'selectionchange', () => this.handleSelectionChange())
    this.registerDomEvent(document, 'mousedown', event => this.handleDocumentMouseDown(event as MouseEvent), { capture: true })
    this.registerDomEvent(document, 'keydown', event => this.handleDocumentKeyDown(event as KeyboardEvent), { capture: true })
    this.registerDomEvent(window, 'resize', () => this.scheduleProcess())
    this.registerDomEvent(window, 'scroll', () => this.scheduleProcess(), { passive: true, capture: true })
    this.registerEvent('wider:mode-changed', () => this.scheduleProcessAfterTransition())
    this.addDisposable(() => {
      this.observer?.disconnect()
      cancelAnimationFrame(this.rafId)
      clearTimeout(this.widerTransitionTimer)
      clearTimeout(this.contextMenuOpeningTimer)
      clearTimeout(this.selectionMenuTimer)
      clearTimeout(this.quickMenuHideTimer)
      this.quickMenuEl?.remove()
      this.quickMenuEl = null
    })
  }

  onunload(): void {
    if (!this.writeEl) return
    this.writeEl.classList.remove('tpl-has-sidenotes')
    this.writeEl.classList.remove('tpl-has-table-sidenotes')
    this.writeEl.querySelectorAll('.tpl-sn-num').forEach(marker => marker.remove())
    this.writeEl.querySelectorAll('.md-html-inline.tpl-sidenote').forEach(el => {
      el.classList.remove('tpl-sidenote')
      el.classList.remove('tpl-sidenote-in-table')
      delete (el as HTMLElement).dataset.tplSnIndex
    })
    this.portalLayerEl?.remove()
    this.portalLayerEl = null
    this.quickMenuEl?.remove()
    this.quickMenuEl = null
    this.clearSavedSelection()
  }

  private addSidenoteFromSelection(): void {
    try {
      const useSavedSelection = this.isQuickMenuOpen() && this.savedSelectionText.trim() !== ''
      this.hideQuickMenu()

      if (this.addSidenoteInSourceMode()) {
        this.clearSavedSelection()
        this.scheduleProcess()
        return
      }

      if (useSavedSelection) this.restoreSavedSelection()
      const selectedText = this.getSelectedText() || (useSavedSelection ? this.savedSelectionText : '')
      editor.insertText(formatSidenoteInsertion(selectedText))
      this.clearSavedSelection()
      this.scheduleProcess()
      this.showNotice(selectedText.trim() ? 'Sidenote added' : 'Empty sidenote inserted')
    } catch (err) {
      console.error('[tpl:sidenote] add sidenote failed:', err)
      this.showNotice('Failed to add sidenote')
    }
  }

  private addSidenoteInSourceMode(): boolean {
    const sourceView = window.File?.editor?.sourceView
    if (!sourceView?.inSourceMode || !sourceView.cm) return false

    const cm = sourceView.cm as {
      getSelection?: () => string
      replaceSelection?: (text: string) => void
      getCursor?: () => { line: number, ch: number }
      setCursor?: (pos: { line: number, ch: number }) => void
    }
    if (typeof cm.replaceSelection !== 'function') return false

    const selectedText = typeof cm.getSelection === 'function' ? cm.getSelection() : ''
    cm.replaceSelection(formatSidenoteInsertion(selectedText))

    if (!selectedText && typeof cm.getCursor === 'function' && typeof cm.setCursor === 'function') {
      const cursor = cm.getCursor()
      cm.setCursor({ line: cursor.line, ch: Math.max(0, cursor.ch - SIDENOTE_TAG_CLOSE.length) })
    }

    this.showNotice(selectedText.trim() ? 'Sidenote added' : 'Empty sidenote inserted')
    return true
  }

  private handleEditorMouseDown(event: MouseEvent): void {
    if (event.button === 2) {
      this.isContextMenuOpening = true
      clearTimeout(this.contextMenuOpeningTimer)
      this.contextMenuOpeningTimer = window.setTimeout(() => {
        this.isContextMenuOpening = false
      }, 800)
      return
    }

    this.clearSavedSelection()
  }

  private handleSelectionChange(): void {
    clearTimeout(this.selectionMenuTimer)

    const selectedText = this.getSelectedText()
    if (selectedText.trim()) {
      this.captureSelection(selectedText)
      this.selectionMenuTimer = window.setTimeout(() => this.showQuickMenuForSelection(), 120)
      return
    }

    if (!this.isContextMenuOpening) {
      this.hideQuickMenu()
      this.clearSavedSelection()
    }
  }

  private handleContextMenu(event: MouseEvent): void {
    if (!this.writeEl || !(event.target instanceof Node) || !this.writeEl.contains(event.target)) return

    clearTimeout(this.contextMenuOpeningTimer)
    this.isContextMenuOpening = false

    const currentSelectedText = this.getSelectedText()
    if (currentSelectedText.trim()) {
      this.captureSelection(currentSelectedText)
    }

    const selectedText = currentSelectedText || this.savedSelectionText
    if (!selectedText.trim()) {
      this.hideQuickMenu()
      return
    }

    event.preventDefault()
    event.stopPropagation()
    this.showQuickMenu(event.clientX, event.clientY)
  }

  private handleDocumentMouseDown(event: MouseEvent): void {
    if (event.target instanceof Node && this.quickMenuEl?.contains(event.target)) return
    this.hideQuickMenu()
  }

  private handleDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') this.hideQuickMenu()
  }

  private showQuickMenu(clientX: number, clientY: number): void {
    const menu = this.ensureQuickMenu()
    this.prepareQuickMenuForMeasurement(menu)

    const rect = menu.getBoundingClientRect()
    const left = Math.min(clientX, Math.max(8, window.innerWidth - rect.width - 8))
    const top = Math.min(clientY, Math.max(8, window.innerHeight - rect.height - 8))

    this.revealQuickMenuAt(Math.max(8, left), Math.max(8, top))
  }

  private showQuickMenuForSelection(): void {
    const rect = this.getSelectionRect()
    if (!rect) return

    const menu = this.ensureQuickMenu()
    this.prepareQuickMenuForMeasurement(menu)

    const menuRect = menu.getBoundingClientRect()
    const x = rect.left + (rect.width / 2) - (menuRect.width / 2)
    const y = rect.top - menuRect.height - 8
    const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - menuRect.width - 8))
    const top = y >= 8 ? y : Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - menuRect.height - 8))

    this.revealQuickMenuAt(left, top)
  }

  private prepareQuickMenuForMeasurement(menu: HTMLDivElement): void {
    clearTimeout(this.quickMenuHideTimer)
    menu.style.display = 'flex'
    menu.classList.remove('tpl-sn-menu-visible')
    menu.style.visibility = 'hidden'
    menu.style.left = '0px'
    menu.style.top = '0px'
  }

  private revealQuickMenuAt(left: number, top: number): void {
    const menu = this.ensureQuickMenu()
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    menu.style.visibility = 'visible'
    requestAnimationFrame(() => {
      menu.classList.add('tpl-sn-menu-visible')
    })
  }

  private hideQuickMenu(): void {
    const menu = this.quickMenuEl
    if (!menu) return

    menu.classList.remove('tpl-sn-menu-visible')
    clearTimeout(this.quickMenuHideTimer)
    this.quickMenuHideTimer = window.setTimeout(() => {
      if (!menu.classList.contains('tpl-sn-menu-visible')) {
        menu.style.display = 'none'
        menu.style.visibility = 'hidden'
      }
    }, 120)
  }

  private isQuickMenuOpen(): boolean {
    return this.quickMenuEl?.style.display === 'block'
  }

  private ensureQuickMenu(): HTMLDivElement {
    if (this.quickMenuEl?.isConnected) return this.quickMenuEl

    const menu = document.createElement('div')
    menu.className = 'tpl-sidenote-quick-menu'
    menu.setAttribute('role', 'toolbar')
    menu.setAttribute('aria-label', 'Sidenote quick actions')

    for (const action of this.getQuickActions()) {
      menu.appendChild(this.createQuickActionButton(action))
    }
    document.body.appendChild(menu)
    this.quickMenuEl = menu
    return menu
  }

  private getQuickActions(): QuickAction[] {
    return [
      {
        id: 'add-sidenote',
        label: 'Add sidenote',
        shortcut: formatHotkeyLabel(ADD_SIDENOTE_HOTKEY),
        run: () => this.addSidenoteFromSelection(),
      },
    ]
  }

  private createQuickActionButton(action: QuickAction): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tpl-sn-action'
    button.dataset.action = action.id
    button.title = action.shortcut ? `${action.label} (${action.shortcut})` : action.label
    button.setAttribute('aria-label', button.title)

    const mark = document.createElement('span')
    mark.className = 'tpl-sn-action-mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.textContent = '+'

    const label = document.createElement('span')
    label.className = 'tpl-sn-action-label'
    label.textContent = action.label

    button.append(mark, label)

    if (action.shortcut) {
      const shortcut = document.createElement('kbd')
      shortcut.className = 'tpl-sn-action-shortcut'
      shortcut.textContent = action.shortcut
      button.appendChild(shortcut)
    }

    button.addEventListener('mousedown', event => {
      event.preventDefault()
      event.stopPropagation()
      action.run()
    })
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
    })

    return button
  }

  private restoreSavedSelection(): void {
    const saved = this.savedSelection as { select?: () => void } | null
    if (!saved) return

    if (typeof saved.select === 'function') {
      saved.select()
      return
    }

    const selection = window.File?.editor?.selection as { setRange?: (range: unknown, preserve?: boolean) => void } | undefined
    selection?.setRange?.(saved, true)
  }

  private captureSelection(selectedText: string): void {
    this.savedSelectionText = selectedText
    const rangy = window.File?.editor?.selection?.getRangy?.()
    this.savedSelection = rangy ?? null
  }

  private clearSavedSelection(): void {
    this.savedSelection = null
    this.savedSelectionText = ''
  }

  private getSelectedText(): string {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return ''
    if (!this.selectionIntersectsWrite(selection)) return ''
    return selection.toString()
  }

  private getSelectionRect(): DOMRect | null {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
    if (!this.selectionIntersectsWrite(selection)) return null

    const range = selection.getRangeAt(0)
    const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
    return rects[0] ?? range.getBoundingClientRect()
  }

  private selectionIntersectsWrite(selection: Selection): boolean {
    if (!this.writeEl) return false

    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i)
      const container = range.commonAncestorContainer
      const node = container.nodeType === Node.ELEMENT_NODE ? container : container.parentNode
      if (node && this.writeEl.contains(node)) return true
    }

    return false
  }

  private processAll(root: HTMLElement): void {
    this.removeMarkersFromFocusedBlocks(root)

    const inlines = root.querySelectorAll<HTMLSpanElement>('span.md-html-inline')
    for (const el of inlines) {
      const canMutateInlineDom = shouldMutateLiveSidenoteDom(el, this.isComposing)

      // Already processed — just ensure marker still exists
      if (el.classList.contains('tpl-sidenote')) {
        if (canMutateInlineDom) {
          this.insertMarker(el)
        } else {
          this.removeMarker(el)
        }
        continue
      }

      if (!canMutateInlineDom) continue

      const before = el.querySelector('.md-meta.md-before')
      if (before && SIDENOTE_RE.test(before.textContent ?? '')) {
        el.classList.add('tpl-sidenote')
        this.insertMarker(el)
      }
    }

    // Clean orphan markers whose sidenote was removed
    root.querySelectorAll('.tpl-sn-num').forEach(marker => {
      if (!marker.nextElementSibling?.classList.contains('tpl-sidenote')) {
        marker.remove()
      }
    })

    const sidenotes = Array.from(root.querySelectorAll<HTMLElement>('.md-html-inline.tpl-sidenote'))
    let hasTableSidenotes = false

    sidenotes.forEach((sidenote, index) => {
      const noteIndex = String(index + 1)
      sidenote.dataset.tplSnIndex = noteIndex

      const marker = sidenote.previousElementSibling
      if (marker?.classList.contains('tpl-sn-num')) {
        ;(marker as HTMLElement).dataset.tplSnIndex = noteIndex
      }

      const inTable = sidenote.closest('td, th') !== null
      sidenote.classList.toggle('tpl-sidenote-in-table', inTable)
      hasTableSidenotes ||= inTable
    })

    root.classList.toggle('tpl-has-sidenotes', sidenotes.length > 0)
    root.classList.toggle('tpl-has-table-sidenotes', hasTableSidenotes)
    this.syncPortals(sidenotes)
  }

  private insertMarker(sidenote: HTMLElement): void {
    if (sidenote.previousElementSibling?.classList.contains('tpl-sn-num')) return
    const marker = document.createElement('span')
    marker.className = 'tpl-sn-num'
    marker.setAttribute('contenteditable', 'false')
    sidenote.parentNode?.insertBefore(marker, sidenote)
  }

  private removeMarker(sidenote: HTMLElement): void {
    const marker = sidenote.previousElementSibling
    if (marker?.classList.contains('tpl-sn-num')) {
      marker.remove()
    }
  }

  private removeMarkersFromFocusedBlocks(root: HTMLElement): void {
    root.querySelectorAll('.md-focus > .tpl-sn-num').forEach(marker => marker.remove())
  }

  private handleCompositionStart(): void {
    this.isComposing = true
    if (this.writeEl) {
      this.removeMarkersFromFocusedBlocks(this.writeEl)
    }
  }

  private handleCompositionEnd(): void {
    this.isComposing = false
    if (this.pendingProcess) {
      this.pendingProcess = false
    }
    this.scheduleProcess()
  }

  private scheduleProcess(): void {
    cancelAnimationFrame(this.rafId)
    if (this.isComposing) {
      this.pendingProcess = true
      return
    }

    this.pendingProcess = false
    this.rafId = requestAnimationFrame(() => {
      if (this.isComposing) {
        this.pendingProcess = true
        return
      }
      if (this.writeEl) this.processAll(this.writeEl)
    })
  }

  /** Wait for wider plugin's CSS transition (180ms) to finish before repositioning */
  private scheduleProcessAfterTransition(): void {
    this.scheduleProcess()
    clearTimeout(this.widerTransitionTimer)
    this.widerTransitionTimer = window.setTimeout(() => {
      this.scheduleProcess()
    }, 200)
  }

  private ensurePortalLayer(): void {
    if (this.portalLayerEl?.isConnected) return

    const layer = document.createElement('div')
    layer.id = 'tpl-sidenote-portal-layer'
    layer.setAttribute('aria-hidden', 'true')
    layer.setAttribute('contenteditable', 'false')
    document.body.appendChild(layer)
    this.portalLayerEl = layer
  }

  private syncPortals(sidenotes: HTMLElement[]): void {
    this.ensurePortalLayer()
    if (!this.writeEl || !this.portalLayerEl) return

    this.portalLayerEl.replaceChildren()

    if (window.innerWidth < 1200) return

    const writeRect = this.writeEl.getBoundingClientRect()
    const portalItems: Array<{ naturalTop: number, el: HTMLElement }> = []

    for (const sidenote of sidenotes) {
      if (sidenote.closest('.md-focus')) continue

      const anchor = sidenote.previousElementSibling?.classList.contains('tpl-sn-num')
        ? sidenote.previousElementSibling as HTMLElement
        : sidenote

      const anchorRect = anchor.getBoundingClientRect()
      const portal = this.createPortal(sidenote)
      const { top, left } = getPortalPagePosition(
        anchorRect,
        writeRect,
        {
          reserve: this.parseCssLength('--tpl-sidenote-reserve', 300),
          offset: this.parseCssLength('--tpl-sidenote-offset', 280),
          width: this.parseCssLength('--tpl-sidenote-width', 250),
        },
        {
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
      )
      portal.style.left = `${left}px`
      portalItems.push({ naturalTop: top, el: portal })
    }

    portalItems.sort((a, b) => a.naturalTop - b.naturalTop)

    let nextTop = -Infinity
    for (const item of portalItems) {
      const top = Math.max(item.naturalTop, nextTop)
      item.el.style.top = `${top}px`
      this.portalLayerEl.appendChild(item.el)
      nextTop = top + item.el.offsetHeight + 12
    }
  }

  private createPortal(source: HTMLElement): HTMLElement {
    const portal = document.createElement('aside')
    portal.className = 'tpl-sidenote-portal'
    portal.dataset.tplSnIndex = source.dataset.tplSnIndex ?? ''
    portal.setAttribute('contenteditable', 'false')

    const body = document.createElement('span')
    body.className = 'tpl-sidenote-portal-body'

    for (const child of Array.from(source.childNodes)) {
      if (child instanceof HTMLElement && child.classList.contains('md-meta')) continue
      body.appendChild(child.cloneNode(true))
    }

    portal.appendChild(body)
    return portal
  }

  private isPortalMutation(mutation: MutationRecord): boolean {
    if (!this.portalLayerEl) return false

    const target = mutation.target
    return target === this.portalLayerEl || this.portalLayerEl.contains(target)
  }

  private parseCssLength(name: string, fallback: number): number {
    if (!this.writeEl) return fallback

    const parsed = Number.parseFloat(getComputedStyle(this.writeEl).getPropertyValue(name).trim())
    return Number.isFinite(parsed) ? parsed : fallback
  }
}

function formatHotkeyLabel(hotkey: string): string {
  return hotkey
    .split('+')
    .map(part => {
      const key = part.trim()
      if (key.toLowerCase() === 'mod') return IS_MAC ? 'Cmd' : 'Ctrl'
      if (key.toLowerCase() === 'alt') return IS_MAC ? 'Opt' : 'Alt'
      return key.length === 1 ? key.toUpperCase() : key
    })
    .join('+')
}

const EDITOR_CSS = /* css */ `
/* ── Sidenote editor styles (injected by plugin) ── */

#write {
  position: relative;
  --tpl-sidenote-width: 250px;
  --tpl-sidenote-reserve: 300px;
  --tpl-sidenote-offset: 280px;
}

.tpl-sidenote-quick-menu {
  position: fixed;
  display: none;
  align-items: stretch;
  gap: 3px;
  min-width: 210px;
  padding: 5px;
  z-index: 99999;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.14));
  border: 1px solid color-mix(in srgb, var(--accent-color, #bc6a3a) 24%, var(--border-color, rgba(0, 0, 0, 0.14)));
  border-radius: 8px;
  background: var(--bg-color, #fff);
  background: color-mix(in srgb, var(--bg-color, #fff) 92%, var(--accent-color, #bc6a3a) 8%);
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.16),
    0 2px 8px rgba(0, 0, 0, 0.08);
  box-sizing: border-box;
  opacity: 0;
  transform: translateY(-3px) scale(0.98);
  transform-origin: 50% 100%;
  transition: opacity 120ms ease-out, transform 120ms ease-out;
  pointer-events: none;
  -webkit-backdrop-filter: saturate(1.2) blur(12px);
  backdrop-filter: saturate(1.2) blur(12px);
}

.tpl-sidenote-quick-menu.tpl-sn-menu-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}

.tpl-sn-action {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  border-radius: 6px;
  padding: 7px 8px 7px 7px;
  background: transparent;
  color: var(--text-color, #333);
  font: inherit;
  font-size: 13px;
  line-height: 1.3;
  text-align: left;
  cursor: default;
  box-sizing: border-box;
  transition: background-color 120ms ease-out, color 120ms ease-out, transform 120ms ease-out;
}

.tpl-sn-action:hover,
.tpl-sn-action:focus-visible {
  background: var(--item-hover-bg-color, rgba(0, 0, 0, 0.06));
  background: color-mix(in srgb, var(--accent-color, #bc6a3a) 14%, transparent);
  outline: none;
}

.tpl-sn-action:active {
  transform: translateY(1px);
}

.tpl-sn-action-mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  background: rgba(188, 106, 58, 0.12);
  background: color-mix(in srgb, var(--accent-color, #bc6a3a) 16%, transparent);
  color: var(--accent-color, #bc6a3a);
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
}

.tpl-sn-action-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.tpl-sn-action-shortcut {
  justify-self: end;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.14));
  border: 1px solid color-mix(in srgb, var(--accent-color, #bc6a3a) 20%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
  background: rgba(255, 255, 255, 0.68);
  background: color-mix(in srgb, var(--bg-color, #fff) 68%, transparent);
  color: var(--text-color, #333);
  color: color-mix(in srgb, var(--text-color, #333) 70%, var(--accent-color, #bc6a3a) 30%);
  font: inherit;
  font-size: 11px;
  line-height: 1.35;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .tpl-sidenote-quick-menu,
  .tpl-sn-action {
    transition: none;
  }
}

/* ── In-text superscript number ── */
.tpl-sn-num {
  user-select: none;
  pointer-events: none;
}
.tpl-sn-num::after {
  content: attr(data-tpl-sn-index);
  font-size: 0.7em;
  position: relative;
  top: -0.5em;
  color: var(--accent-color, #bc6a3a);
  font-weight: 600;
  padding-left: 1px;
}
/* Hide marker when editing the paragraph */
.md-focus > .tpl-sn-num { display: none; }

/* ── Margin note ── */
.md-html-inline.tpl-sidenote {
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--quote-text-color, #625950);
  vertical-align: baseline;
  position: relative;
}

/* Numbered prefix in the margin note: "1. " */
.md-html-inline.tpl-sidenote::before {
  content: attr(data-tpl-sn-index) ". ";
  font-weight: 600;
  color: var(--accent-color, #bc6a3a);
  font-size: 0.78rem;
}

/* Hide prefix when editing */
.md-focus .md-html-inline.tpl-sidenote::before {
  content: none;
}

/* Desktop: float into right margin */
@media (min-width: 1200px) {
#write.tpl-has-sidenotes {
  padding-right: var(--tpl-sidenote-reserve, 300px);
}

/* Typora sets #write pre { width: inherit }, which causes code blocks to
   overflow into the sidenote padding-right reserve. Reset to normal block
   flow so .md-fences fills only the content-box of #write. */
#write.tpl-has-sidenotes .md-fences {
  width: auto;
}
  #tpl-sidenote-portal-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    overflow: visible;
    pointer-events: none;
    z-index: 3;
  }

  .md-html-inline.tpl-sidenote {
    display: none;
  }
  /* When editing the paragraph, pull sidenote back inline */
  .md-focus .md-html-inline.tpl-sidenote {
    display: inline;
    width: auto;
    margin-right: 0;
    margin-bottom: 0;
    border-left: none;
    padding-left: 0;
  }

  .tpl-sidenote-portal {
    position: absolute;
    top: 0;
    width: var(--tpl-sidenote-width, 250px);
    font-size: 0.82rem;
    line-height: 1.45;
    color: var(--quote-text-color, #625950);
    border-left: 2px solid var(--border-color, #ddd5ca);
    padding-left: 10px;
    margin: 0;
    pointer-events: none;
    box-sizing: border-box;
    background: transparent;
  }

  .tpl-sidenote-portal::before {
    content: attr(data-tpl-sn-index) ". ";
    font-weight: 600;
    color: var(--accent-color, #bc6a3a);
    font-size: 0.78rem;
  }
}

/* Narrow screens: inline callout */
@media (max-width: 1199px) {
  .md-html-inline.tpl-sidenote {
    padding: 0.1em 0.4em;
    background: var(--quote-bg-color, #f3ede5);
    border-radius: 4px;
    margin: 0 2px;
  }

  #tpl-sidenote-portal-layer {
    display: none;
  }
}
`
