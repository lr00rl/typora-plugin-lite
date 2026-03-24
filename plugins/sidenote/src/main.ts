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
 * 2. Adds a `tpl-sidenote` CSS class (no DOM insertion — safe for serialization)
 * 3. Injects editor CSS: counter-based numbering, desktop margin float, inline callout
 */
export default class SidenotePlugin extends Plugin {
  private observer: MutationObserver | null = null
  private rafId = 0

  onload(): void {
    const writeEl = document.getElementById('write')
    if (!writeEl) return

    this.registerCss(EDITOR_CSS)
    this.processAll(writeEl)

    this.observer = new MutationObserver(() => {
      cancelAnimationFrame(this.rafId)
      this.rafId = requestAnimationFrame(() => this.processAll(writeEl))
    })

    this.observer.observe(writeEl, { childList: true, subtree: true })
    this.addDisposable(() => {
      this.observer?.disconnect()
      cancelAnimationFrame(this.rafId)
    })
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
  }
}

const EDITOR_CSS = /* css */ `
/* ── Sidenote editor styles (injected by plugin) ── */

#write { counter-reset: sidenote-counter; }

.md-html-inline.tpl-sidenote {
  counter-increment: sidenote-counter;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--quote-text-color, #625950);
  vertical-align: baseline;
  position: relative;
}

/* Numbered prefix: "1. " */
.md-html-inline.tpl-sidenote::before {
  content: counter(sidenote-counter) ". ";
  font-weight: 600;
  color: var(--accent-color, #bc6a3a);
  font-size: 0.78rem;
}

/* Hide prefix when editing (raw tags are visible, prefix would be confusing) */
.md-focus > .md-html-inline.tpl-sidenote::before {
  content: none;
}

/* Desktop: float into right margin */
@media (min-width: 1200px) {
  #write:has(.tpl-sidenote) {
    max-width: 1160px;
    padding-right: 300px;
  }
  .md-html-inline.tpl-sidenote {
    float: right;
    clear: right;
    margin-right: -280px;
    width: 250px;
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
