import { Plugin } from '@typora-plugin-lite/core'

type WiderMode = 'default' | 'wide' | 'full'

interface WiderSettings {
  mode?: WiderMode
  [key: string]: unknown
}

const MODE_ORDER: WiderMode[] = ['default', 'wide', 'full']
const MODE_LABELS: Record<WiderMode, string> = {
  default: 'Default',
  wide: 'Wide',
  full: 'Full',
}

const DEFAULT_CONTENT_WIDTH = 860
const WIDE_CONTENT_WIDTH = 1100
const FULL_MAX_CONTENT_WIDTH = 1800
const MIN_CONTENT_WIDTH = 560
const FALLBACK_SIDENOTE_RESERVE = 300
const SIDENOTE_BREAKPOINT = 1200

export default class WiderPlugin extends Plugin<WiderSettings> {
  private writeEl: HTMLElement | null = null
  private observer: MutationObserver | null = null
  private currentMode: WiderMode = 'default'

  onload(): void {
    this.writeEl = document.getElementById('write')
    if (!this.writeEl) return

    this.registerCss(WIDER_CSS)
    this.currentMode = this.resolveInitialMode()

    this.registerWidthCommands()
    this.registerDomEvent(document, 'keydown', (event) => this.handleEditorHotkey(event as KeyboardEvent), { capture: true })
    this.registerDomEvent(window, 'resize', () => this.handleViewportChange())

    this.observer = new MutationObserver(() => this.applyMode(this.currentMode, false))
    this.observer.observe(this.writeEl, { attributes: true, attributeFilter: ['class'] })
    this.addDisposable(() => this.observer?.disconnect())

    this.applyMode(this.currentMode, false)
  }

  onunload(): void {
    this.observer?.disconnect()

    document.documentElement.style.removeProperty('--tpl-wider-shell-gutter')
    document.documentElement.style.removeProperty('--tpl-wider-content-width')
    document.documentElement.style.removeProperty('--tpl-wider-max-width')

    if (!this.writeEl) return

    delete this.writeEl.dataset.tplWiderMode
    this.writeEl.style.removeProperty('--tpl-wider-shell-gutter')
    this.writeEl.style.removeProperty('--tpl-wider-content-width')
    this.writeEl.style.removeProperty('--tpl-wider-max-width')
  }

  private resolveInitialMode(): WiderMode {
    const mode = this.settings.get('mode')
    if (isWiderMode(mode)) return mode

    this.settings.set('mode', 'default')
    void this.settings.save()
    return 'default'
  }

  private registerWidthCommands(): void {
    this.registerCommand({
      id: 'wider:cycle',
      name: 'Editor Width: Cycle Mode',
      callback: () => this.stepMode(+1),
    })

    this.registerCommand({
      id: 'wider:narrower',
      name: 'Editor Width: Narrower',
      callback: () => this.stepMode(-1),
    })

    this.registerCommand({
      id: 'wider:wider',
      name: 'Editor Width: Wider',
      callback: () => this.stepMode(+1),
    })

    for (const mode of MODE_ORDER) {
      this.registerCommand({
        id: `wider:set-${mode}`,
        name: `Editor Width: ${MODE_LABELS[mode]}`,
        callback: () => this.setMode(mode, true),
      })
    }
  }

  private stepMode(delta: -1 | 1): void {
    const index = MODE_ORDER.indexOf(this.currentMode)
    const next = MODE_ORDER[(index + delta + MODE_ORDER.length) % MODE_ORDER.length] ?? 'default'
    this.setMode(next, true)
  }

  private setMode(mode: WiderMode, announce: boolean): void {
    if (mode !== this.currentMode) {
      this.currentMode = mode
      this.settings.set('mode', mode)
      void this.settings.save()
    }

    this.applyMode(mode, announce)
  }

  private applyMode(mode: WiderMode, announce: boolean): void {
    if (!this.writeEl) return

    const viewportWidth = Math.max(window.innerWidth, document.documentElement.clientWidth)
    const shellGutter = calcViewportGutter(viewportWidth)
    const reserve = this.getActiveSidenoteReserve(viewportWidth)
    const availableContentWidth = Math.max(MIN_CONTENT_WIDTH, viewportWidth - (shellGutter * 2) - reserve)

    let desiredContentWidth = DEFAULT_CONTENT_WIDTH
    if (mode === 'wide') {
      desiredContentWidth = WIDE_CONTENT_WIDTH
    } else if (mode === 'full') {
      desiredContentWidth = Math.min(
        FULL_MAX_CONTENT_WIDTH,
        Math.max(WIDE_CONTENT_WIDTH, availableContentWidth),
      )
    }

    const maxWidth = Math.max(
      MIN_CONTENT_WIDTH + reserve,
      Math.min(viewportWidth - (shellGutter * 2), desiredContentWidth + reserve),
    )
    const appliedContentWidth = Math.max(MIN_CONTENT_WIDTH, maxWidth - reserve)

    this.writeEl.dataset.tplWiderMode = mode
    document.documentElement.style.setProperty('--tpl-wider-shell-gutter', `${shellGutter}px`)
    document.documentElement.style.setProperty('--tpl-wider-content-width', `${appliedContentWidth}px`)
    document.documentElement.style.setProperty('--tpl-wider-max-width', `${maxWidth}px`)
    this.writeEl.style.setProperty('--tpl-wider-shell-gutter', `${shellGutter}px`)
    this.writeEl.style.setProperty('--tpl-wider-content-width', `${appliedContentWidth}px`)
    this.writeEl.style.setProperty('--tpl-wider-max-width', `${maxWidth}px`)

    this.app.events.emit('wider:mode-changed', {
      mode,
      contentWidth: appliedContentWidth,
      maxWidth,
      hasSidenotes: reserve > 0,
    })

    if (announce) {
      this.showNotice(`Editor width: ${MODE_LABELS[mode]}`)
    }
  }

  private handleViewportChange(): void {
    this.applyMode(this.currentMode, false)
  }

  private handleEditorHotkey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null
    if (!target?.closest('#write, #typora-source')) return

    const hasMod = event.metaKey || event.ctrlKey
    if (!hasMod || event.altKey) return

    const isNarrow = event.code === 'BracketLeft' || event.key === '[' || event.key === '{'
    const isWide = event.code === 'BracketRight' || event.key === ']' || event.key === '}'

    if (isNarrow) {
      event.preventDefault()
      event.stopPropagation()
      this.stepMode(-1)
      return
    }

    if (isWide) {
      event.preventDefault()
      event.stopPropagation()
      this.stepMode(+1)
    }
  }

  private getActiveSidenoteReserve(viewportWidth: number): number {
    if (!this.writeEl) return 0
    if (viewportWidth < SIDENOTE_BREAKPOINT) return 0
    if (!this.writeEl.classList.contains('tpl-has-sidenotes')) return 0

    const rawValue = getComputedStyle(this.writeEl).getPropertyValue('--tpl-sidenote-reserve').trim()
    const parsed = Number.parseFloat(rawValue)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_SIDENOTE_RESERVE
  }

}

function isWiderMode(value: unknown): value is WiderMode {
  return typeof value === 'string' && MODE_ORDER.includes(value as WiderMode)
}

function calcViewportGutter(viewportWidth: number): number {
  if (viewportWidth < 1024) return 16
  return clamp(Math.round(viewportWidth * 0.04), 24, 72)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const WIDER_CSS = /* css */ `
#write[data-tpl-wider-mode],
#typora-source {
  box-sizing: border-box;
  width: min(
    calc(100vw - (var(--tpl-wider-shell-gutter, 24px) * 2)),
    var(--tpl-wider-max-width, 860px)
  );
  max-width: var(--tpl-wider-max-width, 860px);
  transition: width 180ms ease, max-width 180ms ease, padding-right 180ms ease;
}

#typora-source {
  margin: 0 auto;
}

#typora-source > .CodeMirror,
#typora-source > .CodeMirror > .CodeMirror-scroll,
#typora-source > .CodeMirror > .CodeMirror-scroll > .CodeMirror-sizer,
#typora-source > .CodeMirror > .CodeMirror-scroll > .CodeMirror-sizer > div,
#typora-source > .CodeMirror > .CodeMirror-scroll > .CodeMirror-sizer > div > .CodeMirror-lines,
#typora-source > .CodeMirror > .CodeMirror-scroll > .CodeMirror-sizer > div > .CodeMirror-lines > div[role="presentation"] {
  box-sizing: border-box;
  width: 100% !important;
  max-width: 100% !important;
}

#typora-source > .CodeMirror {
  width: 100% !important;
  max-width: 100% !important;
  margin: 0 auto;
}

#typora-source > .CodeMirror > .CodeMirror-scroll {
  padding: 0 8px 0 0;
}

#typora-source > .CodeMirror > .CodeMirror-scroll > .CodeMirror-sizer {
  min-width: calc(100% - 40px) !important;
  padding-right: 0 !important;
}

#typora-source > .CodeMirror > .CodeMirror-scroll > .CodeMirror-sizer > div > .CodeMirror-lines {
  padding: 0 !important;
}

#typora-source > .CodeMirror > .CodeMirror-scroll > .CodeMirror-sizer > div > .CodeMirror-lines > div[role="presentation"] > .CodeMirror-code {
  min-width: 100% !important;
}
`
