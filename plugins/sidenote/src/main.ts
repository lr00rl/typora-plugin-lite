import { Plugin } from '@typora-plugin-lite/core'

const SIDENOTE_RE = /class=["'](?:side|margin)note["']/

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

  onload(): void {
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
    this.registerDomEvent(window, 'resize', () => this.scheduleProcess())
    this.registerDomEvent(window, 'scroll', () => this.scheduleProcess(), { passive: true, capture: true })
    this.registerEvent('wider:mode-changed', () => this.scheduleProcess())
    this.addDisposable(() => {
      this.observer?.disconnect()
      cancelAnimationFrame(this.rafId)
    })
  }

  onunload(): void {
    if (!this.writeEl) return
    this.writeEl.classList.remove('tpl-has-sidenotes')
    this.writeEl.classList.remove('tpl-has-table-sidenotes')
    this.writeEl.querySelectorAll('.md-html-inline.tpl-sidenote').forEach(el => {
      el.classList.remove('tpl-sidenote')
      el.classList.remove('tpl-sidenote-in-table')
      delete (el as HTMLElement).dataset.tplSnIndex
    })
    this.portalLayerEl?.remove()
    this.portalLayerEl = null
  }

  private processAll(root: HTMLElement): void {
    const inlines = root.querySelectorAll<HTMLSpanElement>('span.md-html-inline')
    for (const el of inlines) {
      if (el.classList.contains('tpl-sidenote')) continue
      const before = el.querySelector('.md-meta.md-before')
      if (before && SIDENOTE_RE.test(before.textContent ?? '')) {
        el.classList.add('tpl-sidenote')
      }
    }

    const sidenotes = Array.from(root.querySelectorAll<HTMLElement>('.md-html-inline.tpl-sidenote'))
    let hasTableSidenotes = false

    sidenotes.forEach((sidenote, index) => {
      const noteIndex = String(index + 1)
      sidenote.dataset.tplSnIndex = noteIndex

      const inTable = sidenote.closest('td, th') !== null
      sidenote.classList.toggle('tpl-sidenote-in-table', inTable)
      hasTableSidenotes ||= inTable
    })

    root.classList.toggle('tpl-has-sidenotes', sidenotes.length > 0)
    root.classList.toggle('tpl-has-table-sidenotes', hasTableSidenotes)
    this.syncPortals(sidenotes)
  }

  private scheduleProcess(): void {
    cancelAnimationFrame(this.rafId)
    this.rafId = requestAnimationFrame(() => {
      if (this.writeEl) this.processAll(this.writeEl)
    })
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

      const anchorRect = sidenote.getBoundingClientRect()
      const naturalTop = Math.max(0, anchorRect.top)
      const portal = this.createPortal(sidenote)
      portalItems.push({ naturalTop, el: portal })
    }

    portalItems.sort((a, b) => a.naturalTop - b.naturalTop)

    let nextTop = 0
    for (const item of portalItems) {
      const top = Math.max(item.naturalTop, nextTop)
      item.el.style.top = `${top}px`
      item.el.style.left = `${this.calcPortalLeft(writeRect)}px`
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

  private calcPortalLeft(writeRect: DOMRect): number {
    if (!this.writeEl) return writeRect.right

    const styles = getComputedStyle(this.writeEl)
    const reserve = this.parseCssLength(styles.getPropertyValue('--tpl-sidenote-reserve'), 300)
    const offset = this.parseCssLength(styles.getPropertyValue('--tpl-sidenote-offset'), 280)
    const width = this.parseCssLength(styles.getPropertyValue('--tpl-sidenote-width'), 250)
    return writeRect.right - (reserve - offset) - width
  }

  private parseCssLength(value: string, fallback: number): number {
    const parsed = Number.parseFloat(value.trim())
    return Number.isFinite(parsed) ? parsed : fallback
  }
}

const EDITOR_CSS = /* css */ `
/* ── Sidenote editor styles (injected by plugin) ── */

#write {
  position: relative;
  --tpl-sidenote-width: 250px;
  --tpl-sidenote-reserve: 300px;
  --tpl-sidenote-offset: 280px;
}

.md-html-inline.tpl-sidenote {
  position: relative;
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
	    position: fixed;
	    inset: 0;
	    overflow: visible;
	    pointer-events: none;
	    z-index: 3;
	  }

	  #write.tpl-has-sidenotes .md-html-inline.tpl-sidenote {
	    display: inline-block;
	    width: 0;
	    min-width: 0;
	    margin: 0;
	    padding: 0;
	    border: 0;
	    overflow: visible;
	    white-space: nowrap;
	    vertical-align: baseline;
	    font-size: 0;
	    line-height: 0;
	    color: transparent;
	  }

	  #write.tpl-has-sidenotes .md-html-inline.tpl-sidenote::before {
	    content: attr(data-tpl-sn-index);
	    font-size: 0.7rem;
	    line-height: 1;
	    position: relative;
	    top: -0.5em;
	    color: var(--accent-color, #bc6a3a);
	    font-weight: 600;
	    padding-left: 1px;
	  }

	  /* When editing the paragraph, pull sidenote back inline */
	  #write.tpl-has-sidenotes .md-focus .md-html-inline.tpl-sidenote {
	    display: inline;
	    width: auto;
	    min-width: auto;
	    margin-right: 0;
	    margin-bottom: 0;
	    border-left: none;
	    padding-left: 0;
	    overflow: visible;
	    white-space: normal;
	    vertical-align: baseline;
	    font-size: 0.82rem;
	    line-height: 1.45;
	    color: var(--quote-text-color, #625950);
	  }

	  #write.tpl-has-sidenotes .md-focus .md-html-inline.tpl-sidenote::before {
	    content: attr(data-tpl-sn-index) ". ";
	    font-size: 0.78rem;
	    line-height: inherit;
	    top: 0;
	  }

	  .tpl-sidenote-portal {
	    position: absolute;
    top: 0;
    right: calc(var(--tpl-sidenote-reserve, 300px) - var(--tpl-sidenote-offset, 280px));
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
    font-size: 0.82rem;
    line-height: 1.45;
    color: var(--quote-text-color, #625950);
    padding: 0.1em 0.4em;
    background: var(--quote-bg-color, #f3ede5);
    border-radius: 4px;
    margin: 0 2px;
  }

  .md-html-inline.tpl-sidenote::before {
    content: attr(data-tpl-sn-index) ". ";
    font-weight: 600;
    color: var(--accent-color, #bc6a3a);
    font-size: 0.78rem;
  }

  #tpl-sidenote-portal-layer {
    display: none;
  }
}
`
