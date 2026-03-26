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
 * 3. CSS counter drives matching numbers on both the in-text marker and margin note
 *
 * DOM insertion is safe — Typora serializes from its markdown source,
 * not from the live DOM (same pattern as fence-enhance's copy button).
 */
export default class SidenotePlugin extends Plugin {
  private observer: MutationObserver | null = null
  private rafId = 0
  private writeEl: HTMLElement | null = null

  onload(): void {
    this.writeEl = document.getElementById('write')
    if (!this.writeEl) return

    this.registerCss(EDITOR_CSS)
    this.processAll(this.writeEl)

    this.observer = new MutationObserver(() => {
      cancelAnimationFrame(this.rafId)
      this.rafId = requestAnimationFrame(() => {
        if (this.writeEl) this.processAll(this.writeEl)
      })
    })

    this.observer.observe(this.writeEl, { childList: true, subtree: true })
    this.addDisposable(() => {
      this.observer?.disconnect()
      cancelAnimationFrame(this.rafId)
    })
  }

  onunload(): void {
    if (!this.writeEl) return
    this.writeEl.classList.remove('tpl-has-sidenotes')
    this.writeEl.querySelectorAll('.tpl-sn-num').forEach(marker => marker.remove())
    this.writeEl.querySelectorAll('.md-html-inline.tpl-sidenote').forEach(el => {
      el.classList.remove('tpl-sidenote')
    })
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

    root.classList.toggle('tpl-has-sidenotes', root.querySelector('.tpl-sidenote') !== null)
  }

  private insertMarker(sidenote: HTMLElement): void {
    const marker = document.createElement('span')
    marker.className = 'tpl-sn-num'
    marker.contentEditable = 'false'
    sidenote.parentNode?.insertBefore(marker, sidenote)
  }
}

const EDITOR_CSS = /* css */ `
/* ── Sidenote editor styles (injected by plugin) ── */

#write {
  counter-reset: sidenote-counter;
  --tpl-sidenote-width: 250px;
  --tpl-sidenote-reserve: 300px;
  --tpl-sidenote-offset: 280px;
}

/* ── In-text superscript number ── */
.tpl-sn-num {
  counter-increment: sidenote-counter;
  user-select: none;
  pointer-events: none;
}
.tpl-sn-num::after {
  content: counter(sidenote-counter);
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
  content: counter(sidenote-counter) ". ";
  font-weight: 600;
  color: var(--accent-color, #bc6a3a);
  font-size: 0.78rem;
}

/* Hide prefix when editing */
.md-focus > .md-html-inline.tpl-sidenote::before {
  content: none;
}

/* Desktop: float into right margin */
@media (min-width: 1200px) {
  #write.tpl-has-sidenotes {
    padding-right: var(--tpl-sidenote-reserve, 300px);
  }
  .md-html-inline.tpl-sidenote {
    float: right;
    clear: right;
    margin-right: calc(-1 * var(--tpl-sidenote-offset, 280px));
    width: var(--tpl-sidenote-width, 250px);
    margin-top: 0;
    margin-bottom: 1rem;
    border-left: 2px solid var(--border-color, #ddd5ca);
    padding-left: 10px;
  }
  /* When editing the paragraph, pull sidenote back inline */
  .md-focus > .md-html-inline.tpl-sidenote {
    float: none;
    width: auto;
    margin-right: 0;
    margin-bottom: 0;
    border-left: none;
    padding-left: 0;
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
}
`
