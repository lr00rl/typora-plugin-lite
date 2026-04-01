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
  private widerTransitionTimer = 0

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
    this.registerEvent('wider:mode-changed', () => this.scheduleProcessAfterTransition())
    this.addDisposable(() => {
      this.observer?.disconnect()
      cancelAnimationFrame(this.rafId)
      clearTimeout(this.widerTransitionTimer)
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
  }

  private processAll(root: HTMLElement): void {
    const inlines = root.querySelectorAll<HTMLSpanElement>('span.md-html-inline')
    for (const el of inlines) {
      // Already processed — just ensure marker still exists
      if (el.classList.contains('tpl-sidenote')) {
        if (!el.previousElementSibling?.classList.contains('tpl-sn-num')) {
          this.insertMarker(el)
        }
        continue
      }
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
    const marker = document.createElement('span')
    marker.className = 'tpl-sn-num'
    marker.setAttribute('contenteditable', 'false')
    sidenote.parentNode?.insertBefore(marker, sidenote)
  }

  private scheduleProcess(): void {
    cancelAnimationFrame(this.rafId)
    this.rafId = requestAnimationFrame(() => {
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
    if (!this.writeEl) return

    const layer = document.createElement('div')
    layer.id = 'tpl-sidenote-portal-layer'
    layer.setAttribute('aria-hidden', 'true')
    layer.setAttribute('contenteditable', 'false')
    this.writeEl.appendChild(layer)
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
      const naturalTop = anchorRect.top - writeRect.top
      const portal = this.createPortal(sidenote)
      portalItems.push({ naturalTop, el: portal })
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
}

const EDITOR_CSS = /* css */ `
/* ── Sidenote editor styles (injected by plugin) ── */

#write {
  position: relative;
  --tpl-sidenote-width: 250px;
  --tpl-sidenote-reserve: 300px;
  --tpl-sidenote-offset: 280px;
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
    inset: 0;
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
