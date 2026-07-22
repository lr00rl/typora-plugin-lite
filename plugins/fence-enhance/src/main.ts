import { Plugin, detectIndentUnit, guideColumnsPerLine, indentGuideBackground, type SettingsSchema } from '@typora-plugin-lite/core'

import { applyGutterDigits, countFenceLines, digitsForLineCount } from './gutter.js'
import { FENCE_SELECTOR, getFenceCm, initFence, isModeLoaded } from './typora-fences.js'
import { FenceWarmer } from './warmer.js'

interface FenceEnhanceSettings extends Record<string, unknown> {
  copyButton: boolean
  /**
   * 'progressive' — warm every block top-to-bottom during idle time (default).
   * 'viewport'    — only warm blocks approaching the viewport. Cheaper on huge
   *                 documents; still far ahead of Typora's zero-margin default.
   * 'off'         — leave Typora's 8-eager/lazy-rest behaviour alone.
   */
  eagerRender: 'progressive' | 'viewport' | 'off'
  /** How far outside the viewport (px) to warm blocks. */
  prewarmMargin: number
  adaptiveGutter: boolean
  /** Vertical indent-alignment rules inside code blocks. */
  indentGuides: boolean
  /** Overlay » on CodeMirror's cm-tab spans (visual only; copy unaffected). */
  tabMarkers: boolean
}

const DEFAULT_SETTINGS: FenceEnhanceSettings = {
  copyButton: true,
  eagerRender: 'progressive',
  prewarmMargin: 1200,
  adaptiveGutter: true,
  indentGuides: true,
  tabMarkers: true,
}

/** Coalesce the mutation storm CodeMirror makes while you type inside a block. */
const MUTATION_DEBOUNCE_MS = 150

/** tab-size assumed for guide positions (Typora fences default to 4). */
const TAB_SIZE = 4

const CSS = `
/* ── Adaptive line-number gutter ───────────────────────────────────────────
 * The width is derived from --tpl-lineno-digits, which this plugin sets on
 * each .md-fences individually from that block's real line count. A 7-line
 * snippet reserves 2 digit columns; a 1200-line file reserves 4.
 *
 * Themes that draw their own line numbers (claude-like does) should consume
 * --code-line-number-gutter-width rather than hard-coding a width. The
 * fallbacks here keep the plugin correct on themes that don't. */
.md-fences-with-lineno {
  --tpl-lineno-digits: 2;
  --tpl-lineno-padding: 1.4em;
  --code-line-number-gutter-width:
    calc(var(--tpl-lineno-digits) * 1ch + var(--tpl-lineno-padding));
}

/* Copy button */
.tpl-fence-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  padding: 2px 8px;
  border: 1px solid rgba(128,128,128,0.3);
  border-radius: 4px;
  background: rgba(128,128,128,0.1);
  color: var(--text-color, #666);
  font-size: 12px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 10;
}
.md-fences:hover .tpl-fence-copy {
  opacity: 1;
}
.tpl-fence-copy:hover {
  background: rgba(128,128,128,0.2);
}
.tpl-fence-copy.tpl-copied {
  color: #4caf50;
}

/* Ensure fences are positioned for absolute children */
.md-fences {
  position: relative;
}

/* ── Tab markers ─────────────────────────────────────────────────────────
 * CodeMirror renders tab characters as standalone span.cm-tab elements, so a
 * » overlay needs no DOM mutation at all — the tab char stays (layout + copy
 * unaffected), it is just made invisible. Scoped under html.tpl-fence-tabmarks
 * so the setting can turn it off without a reload.
 */
html.tpl-fence-tabmarks .md-fences .cm-tab {
  position: relative;
  color: transparent;
}
html.tpl-fence-tabmarks .md-fences .cm-tab::before {
  content: '»';
  position: absolute;
  left: 0;
  color: var(--tpl-ws-color, rgba(128,128,128,0.55));
}
`

export default class FenceEnhancePlugin extends Plugin<FenceEnhanceSettings> {
  static defaultSettings: FenceEnhanceSettings = { ...DEFAULT_SETTINGS }

  static settingsSchema: SettingsSchema<FenceEnhanceSettings> = {
    fields: {
      eagerRender: {
        kind: 'enum',
        label: 'Code block rendering',
        description:
          'Typora only renders the first 8 code blocks up front and leaves the rest grey until you scroll onto them. "Progressive" renders them all in the background, top to bottom.',
        section: 'Rendering',
        options: [
          { value: 'progressive', label: 'Progressive — render the whole document in the background' },
          { value: 'viewport', label: 'Viewport — render blocks as they approach the screen' },
          { value: 'off', label: "Off — leave Typora's default lazy behaviour" },
        ],
      },
      prewarmMargin: {
        kind: 'number',
        label: 'Pre-render distance (px)',
        description:
          "How far off-screen to render blocks ahead of the scroll. Typora's own value is effectively 0, which is why blocks light up late.",
        section: 'Rendering',
        min: 0,
        max: 10000,
      },
      adaptiveGutter: {
        kind: 'toggle',
        label: 'Adaptive line-number width',
        description:
          "Size each code block's line-number gutter to its own line count, instead of reserving a fixed width for every block.",
        section: 'Rendering',
      },
      indentGuides: {
        kind: 'toggle',
        label: 'Indent guides',
        description:
          'Vertical alignment rules at every tab stop of a code line\'s indentation. Same look as the Code Viewer pane.',
        section: 'Rendering',
      },
      tabMarkers: {
        kind: 'toggle',
        label: 'Tab markers (»)',
        description:
          'Overlay a » on every tab in a code block. Visual only — the document and copying are untouched.',
        section: 'Rendering',
      },
      copyButton: {
        kind: 'toggle',
        label: 'Copy button',
        description: 'Show a copy button in the top-right of each code block on hover.',
        section: 'Extras',
      },
    },
    sections: {
      Rendering: { title: 'Rendering', order: 1 },
      Extras: { title: 'Extras', order: 2 },
    },
    order: ['eagerRender', 'prewarmMargin', 'adaptiveGutter', 'indentGuides', 'tabMarkers', 'copyButton'],
  }

  private mutationObserver: MutationObserver | null = null
  private viewportObserver: IntersectionObserver | null = null
  private warmer: FenceWarmer | null = null
  private copyButtons = new Set<HTMLElement>()
  private mutationTimer: number | null = null
  /** Indent-guide backgrounds, one per distinct guide set — shared by all lines. */
  private guideCache = new Map<string, { image: string; size: string } | null>()
  /** Fences edited since the last debounce flush. */
  private dirty = new Set<HTMLElement>()
  /**
   * Whether any mutation since the last flush added/removed whole blocks (vs.
   * only edits inside existing ones). Sticky across the debounce window so a
   * late non-structural batch can't cancel a pending whole-document warm pass.
   */
  private pendingStructural = false

  _init(...args: Parameters<Plugin<FenceEnhanceSettings>['_init']>): void {
    super._init(args[0], args[1], DEFAULT_SETTINGS)
  }

  onload(): void {
    this.registerCss(CSS)
    this.syncTabMarkerClass()

    this.warmer = new FenceWarmer({
      collect: () => Array.from(document.querySelectorAll(FENCE_SELECTOR)),
      warm: fence => initFence(fence),
      ready: () => isModeLoaded(),
      // A freshly-initialized fence swaps a raw text node for a CodeMirror
      // subtree, so its real line count only becomes readable now.
      onWarmed: fences => {
        for (const fence of fences) this.refreshFence(fence as HTMLElement)
      },
    })

    this.addDisposable(() => {
      this.warmer?.stop()
      this.viewportObserver?.disconnect()
      this.mutationObserver?.disconnect()
      if (this.mutationTimer !== null) window.clearTimeout(this.mutationTimer)
      for (const btn of this.copyButtons) btn.remove()
      this.copyButtons.clear()
      document.documentElement.classList.remove('tpl-fence-tabmarks')
      for (const fence of document.querySelectorAll(FENCE_SELECTOR)) {
        for (const line of fence.querySelectorAll<HTMLElement>('.CodeMirror-line')) {
          this.clearGuide(line)
        }
      }
    })

    this.observeDocument()
    this.schedulePass()

    // Changing how blocks render has to take effect without a restart —
    // otherwise the setting reads as broken.
    this.addDisposable(
      this.settings.onChange(() => {
        this.syncTabMarkerClass()
        this.schedulePass()
      }),
    )
  }

  onunload(): void {
    this.warmer?.stop()
  }

  /**
   * Watch #write for structural change. Deliberately one coarse observer rather
   * than several precise hooks: it catches a whole-document swap (opening
   * another file), a single block being pasted in, and CodeMirror adding a line
   * div as you type — all of which need the same response.
   */
  private observeDocument(): void {
    const write = document.querySelector('#write')
    if (!write) return

    this.mutationObserver = new MutationObserver(mutations => {
      let structural = false
      for (const mutation of mutations) {
        const target = mutation.target as HTMLElement
        const fence = target.closest?.(FENCE_SELECTOR) as HTMLElement | null
        if (fence) {
          // Edit inside an existing block: its line count may have changed, but
          // the set of blocks in the document did not.
          this.dirty.add(fence)
          continue
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.matches?.(FENCE_SELECTOR) || node.querySelector?.(FENCE_SELECTOR)) {
            structural = true
          }
        }
      }
      if (structural) this.pendingStructural = true
      this.scheduleFlush()
    })

    this.mutationObserver.observe(write, { childList: true, subtree: true })
  }

  private scheduleFlush(): void {
    if (this.mutationTimer !== null) window.clearTimeout(this.mutationTimer)
    this.mutationTimer = window.setTimeout(() => {
      this.mutationTimer = null
      // `structural` must be sticky across the whole debounce window. Opening a
      // file fires the added-fence mutations *and*, milliseconds later, the
      // CodeMirror-init mutations for Typora's eager blocks (which live inside
      // fences → non-structural). If a per-batch flag were passed in, that
      // second batch would reset the timer with structural=false and the
      // whole-document warm pass would never run.
      const structural = this.pendingStructural
      this.pendingStructural = false
      const dirty = Array.from(this.dirty)
      this.dirty.clear()

      if (structural) {
        // New blocks appeared (or a different file was opened) — re-run the
        // whole pass, which re-collects fences in document order.
        this.schedulePass()
        return
      }
      for (const fence of dirty) {
        if (fence.isConnected) this.refreshFence(fence)
      }
    }, MUTATION_DEBOUNCE_MS)
  }

  /** Re-warm and re-decorate the current document from the top. */
  private schedulePass(): void {
    this.rebuildViewportObserver()

    if (this.settings.get('eagerRender') === 'progressive') {
      this.warmer?.restart()
    } else {
      this.warmer?.stop()
    }

    // Decorate what's already on screen immediately; the warmer calls back for
    // the rest as it reaches them.
    for (const fence of document.querySelectorAll(FENCE_SELECTOR)) {
      this.refreshFence(fence as HTMLElement)
    }
  }

  /**
   * Our own IntersectionObserver, with a real rootMargin.
   *
   * In 'viewport' mode this is the whole strategy. In 'progressive' mode it is
   * a safety net: it catches blocks the idle warmer hasn't reached yet when the
   * user scrolls fast, and blocks in a document too large for the warmer to
   * take on. Warming a block that is already live is a no-op, so the two
   * overlap harmlessly.
   */
  private rebuildViewportObserver(): void {
    this.viewportObserver?.disconnect()
    this.viewportObserver = null

    if (this.settings.get('eagerRender') === 'off') return

    const margin = Math.max(0, this.settings.get('prewarmMargin'))
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.intersectionRatio <= 0) continue
          const fence = entry.target as HTMLElement
          initFence(fence)
          this.refreshFence(fence)
          observer.unobserve(fence)
        }
      },
      { rootMargin: `${margin}px 0px ${margin}px 0px` },
    )
    this.viewportObserver = observer

    for (const fence of document.querySelectorAll(FENCE_SELECTOR)) {
      if (!getFenceCm(fence)) observer.observe(fence)
    }
  }

  /** Bring one fence up to date: copy button + gutter width + indent guides. */
  private refreshFence(fence: HTMLElement): void {
    if (this.settings.get('copyButton')) this.addCopyButton(fence)
    this.applyIndentGuides(fence)
    if (!this.settings.get('adaptiveGutter')) return

    const lines = countFenceLines(fence, getFenceCm(fence))
    applyGutterDigits(fence, digitsForLineCount(lines))
  }

  /**
   * Paint indent guides on a fence's CodeMirror lines.
   *
   * This is deliberately a STYLE-ONLY enhancement: CodeMirror's lineView
   * caches text-node references for cursor measurement, so injecting marker
   * spans into a fence (the way the Code Viewer pane does for whitespace)
   * would break editing. A background-image on the line box is invisible to
   * CodeMirror, never touches the text, and therefore cannot affect copy,
   * selection, or measurement. Lines CodeMirror re-renders simply lose the
   * style and get it back on the next mutation flush.
   */
  private applyIndentGuides(fence: HTMLElement): void {
    const enabled = this.settings.get('indentGuides')
    const lineEls = Array.from(fence.querySelectorAll<HTMLElement>('.CodeMirror-line'))
    if (lineEls.length === 0) return
    if (!enabled) {
      for (const line of lineEls) this.clearGuide(line)
      return
    }
    const texts = lineEls.map(line => line.textContent ?? '')
    const unit = detectIndentUnit(texts, TAB_SIZE)
    const perLine = guideColumnsPerLine(texts, TAB_SIZE, unit)
    lineEls.forEach((line, i) => {
      const bg = this.guideBg(perLine[i] ?? [])
      if (!bg) { this.clearGuide(line); return }
      line.style.backgroundImage = bg.image
      line.style.backgroundSize = bg.size
      line.style.backgroundRepeat = 'no-repeat'
      line.dataset.tplGuide = '1'
    })
  }

  private guideBg(cols: number[]): { image: string; size: string } | null {
    const key = cols.join(',')
    let bg = this.guideCache.get(key)
    if (bg === undefined) {
      bg = indentGuideBackground(cols, 'var(--tpl-guide-color, rgba(128,128,128,0.3))')
      this.guideCache.set(key, bg)
    }
    return bg
  }

  private clearGuide(line: HTMLElement): void {
    if (!line.dataset.tplGuide) return
    delete line.dataset.tplGuide
    line.style.backgroundImage = ''
    line.style.backgroundSize = ''
    line.style.backgroundRepeat = ''
  }

  private syncTabMarkerClass(): void {
    document.documentElement.classList.toggle('tpl-fence-tabmarks', this.settings.get('tabMarkers'))
  }

  private addCopyButton(fence: HTMLElement): void {
    if (fence.querySelector('.tpl-fence-copy')) return

    const btn = document.createElement('button')
    btn.className = 'tpl-fence-copy'
    btn.textContent = 'Copy'
    btn.addEventListener('click', e => {
      e.stopPropagation()
      this.copyFenceContent(fence, btn)
    })
    fence.appendChild(btn)
    this.copyButtons.add(btn)
  }

  private copyFenceContent(fence: HTMLElement, btn: HTMLElement): void {
    let text: string

    // A live CodeMirror is the only place the *unwrapped* source exists: the
    // rendered line divs are subject to soft-wrap and would copy back with
    // spurious line breaks.
    const value = (getFenceCm(fence) as any)?.getValue?.()
    if (typeof value === 'string') {
      text = value
    } else {
      const lines = fence.querySelectorAll('.CodeMirror-line')
      if (lines.length > 0) {
        text = Array.from(lines).map(line => line.textContent ?? '').join('\n')
      } else {
        const clone = fence.cloneNode(true) as HTMLElement
        clone.querySelectorAll('.tpl-fence-copy').forEach(el => el.remove())
        const codeEl = clone.querySelector('code') ?? clone.querySelector('pre')
        text = codeEl?.textContent ?? clone.textContent ?? ''
      }
    }

    navigator.clipboard.writeText(text.trimEnd()).then(
      () => {
        btn.textContent = 'Copied!'
        btn.classList.add('tpl-copied')
        setTimeout(() => {
          btn.textContent = 'Copy'
          btn.classList.remove('tpl-copied')
        }, 1500)
      },
      () => {
        btn.textContent = 'Failed'
        setTimeout(() => { btn.textContent = 'Copy' }, 1500)
      },
    )
  }
}
