import { Plugin, type SettingsSchema } from '@typora-plugin-lite/core'
import { calculateWiderLayout, type WiderLayout, type WiderMode } from './layout'

interface WiderSettings {
  mode?: WiderMode
  [key: string]: unknown
}

interface AppliedWiderLayout extends WiderLayout {
  mode: WiderMode
  viewportWidth: number
  sidenoteReserve: number
  actualWidth: number
  computedWidth: string
  computedMaxWidth: string
  writeCandidateCount: number
  datasetMode: string
  inlineMaxWidthVariable: string
  rootMaxWidthVariable: string
  inlineWidthProperty: string
  inlineMaxWidthProperty: string
}

const MODE_ORDER: WiderMode[] = ['default', 'wide', 'full']
const MODE_LABELS: Record<WiderMode, string> = {
  default: 'Default',
  wide: 'Wide',
  full: 'Full',
}

const FALLBACK_SIDENOTE_RESERVE = 300
const SIDENOTE_BREAKPOINT = 1200

export default class WiderPlugin extends Plugin<WiderSettings> {
  /** Declarative schema so the Plugin Center renders a segmented control for mode. */
  static settingsSchema: SettingsSchema<WiderSettings> = {
    fields: {
      mode: {
        kind: 'enum',
        label: 'Editor width',
        description: 'Switch the writing area between Default, Wide, and Full. Changing the mode here is equivalent to running the `wider:set-*` command.',
        options: [
          { value: 'default', label: 'Default', hint: 'Focused reading column, up to 860px.' },
          { value: 'wide', label: 'Wide', hint: 'Responsive 1000–1180px width for technical documents.' },
          { value: 'full', label: 'Full', hint: 'Use available space for tables and diagrams, capped at 1680px.' },
        ],
        style: 'segmented',
      },
    },
  }

  static defaultSettings: WiderSettings = { mode: 'default' }

  private writeEl: HTMLElement | null = null
  private observer: MutationObserver | null = null
  private currentMode: WiderMode = 'default'

  onload(): void {
    this.registerCss(WIDER_CSS)
    this.currentMode = this.resolveInitialMode()

    this.registerWidthCommands()
    this.registerDomEvent(document, 'keydown', (event) => this.handleEditorHotkey(event as KeyboardEvent), { capture: true })
    this.registerDomEvent(window, 'resize', () => this.handleViewportChange())

    this.observer = new MutationObserver(() => this.applyMode(this.currentMode, false))
    this.addDisposable(() => this.observer?.disconnect())

    // Typora replaces #write when switching files. Poll only for element
    // identity changes, then rebind once; observing the whole document would
    // run on every editing mutation and create unnecessary hot-path work.
    this.registerInterval(() => {
      const activeWriteEl = this.findActiveWritingArea()
      if (activeWriteEl && activeWriteEl !== this.writeEl) {
        this.applyMode(this.currentMode, false)
      }
    }, 500)

    // Apply settings edits coming from outside (e.g. Plugin Center UI) live,
    // without having to round-trip through a command. setMode() already mutates
    // currentMode before calling settings.set(), so this handler is a no-op on
    // self-triggered changes.
    this.addDisposable(this.settings.onChange((key, value) => {
      if (key !== 'mode' || !isWiderMode(value)) return
      if (value === this.currentMode) return
      this.currentMode = value
      this.applyMode(value, true)
    }))

    this.applyMode(this.currentMode, false)
  }

  onunload(): void {
    this.observer?.disconnect()

    document.documentElement.style.removeProperty('--tpl-wider-shell-gutter')
    document.documentElement.style.removeProperty('--tpl-wider-content-width')
    document.documentElement.style.removeProperty('--tpl-wider-max-width')

    this.clearWriteOverrides(this.writeEl)
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

  private stepMode(delta: -1 | 1): AppliedWiderLayout | null {
    const index = MODE_ORDER.indexOf(this.currentMode)
    const next = MODE_ORDER[(index + delta + MODE_ORDER.length) % MODE_ORDER.length] ?? 'default'
    return this.setMode(next, true)
  }

  private setMode(mode: WiderMode, announce: boolean): AppliedWiderLayout | null {
    if (mode !== this.currentMode) {
      this.currentMode = mode
      this.settings.set('mode', mode)
      void this.settings.save()
    }

    return this.applyMode(mode, announce)
  }

  private applyMode(mode: WiderMode, announce: boolean): AppliedWiderLayout | null {
    // Typora can retain multiple #write nodes briefly while switching files.
    // Resolve the visible editor rather than trusting File.editor.writingArea
    // or the first duplicate id returned by getElementById.
    const activeWriteEl = this.findActiveWritingArea()
    if (activeWriteEl && activeWriteEl !== this.writeEl) {
      this.bindWritingArea(activeWriteEl)
    }
    if (!this.writeEl) return null

    const viewportWidth = Math.max(window.innerWidth, document.documentElement.clientWidth)
    const reserve = this.getActiveSidenoteReserve(viewportWidth)
    const {
      shellGutter,
      contentWidth: appliedContentWidth,
      maxWidth,
    } = calculateWiderLayout({ mode, viewportWidth, sidenoteReserve: reserve })

    this.writeEl.dataset.tplWiderMode = mode
    document.documentElement.style.setProperty('--tpl-wider-shell-gutter', `${shellGutter}px`)
    document.documentElement.style.setProperty('--tpl-wider-content-width', `${appliedContentWidth}px`)
    document.documentElement.style.setProperty('--tpl-wider-max-width', `${maxWidth}px`)
    this.writeEl.style.setProperty('--tpl-wider-shell-gutter', `${shellGutter}px`)
    this.writeEl.style.setProperty('--tpl-wider-content-width', `${appliedContentWidth}px`)
    this.writeEl.style.setProperty('--tpl-wider-max-width', `${maxWidth}px`)
    // Typora and third-party themes can inject #write rules after plugin CSS.
    // Inline geometry is the reliable boundary here; it remains reversible in
    // clearWriteOverrides and is recalculated on every viewport change.
    this.writeEl.style.setProperty('width', `${maxWidth}px`, 'important')
    this.writeEl.style.setProperty('max-width', `${maxWidth}px`, 'important')

    const computedStyle = getComputedStyle(this.writeEl)
    const appliedLayout: AppliedWiderLayout = {
      mode,
      viewportWidth,
      sidenoteReserve: reserve,
      shellGutter,
      contentWidth: appliedContentWidth,
      maxWidth,
      actualWidth: Math.round(this.writeEl.getBoundingClientRect().width),
      computedWidth: computedStyle.width,
      computedMaxWidth: computedStyle.maxWidth,
      writeCandidateCount: document.querySelectorAll('#write').length,
      datasetMode: this.writeEl.dataset.tplWiderMode ?? '',
      inlineMaxWidthVariable: this.writeEl.style.getPropertyValue('--tpl-wider-max-width'),
      rootMaxWidthVariable: document.documentElement.style.getPropertyValue('--tpl-wider-max-width'),
      inlineWidthProperty: this.writeEl.style.width,
      inlineMaxWidthProperty: this.writeEl.style.maxWidth,
    }
    this.app.events.emit('wider:mode-changed', {
      ...appliedLayout,
      hasSidenotes: reserve > 0,
    })

    if (announce) {
      this.showNotice(`Editor width: ${MODE_LABELS[mode]}`)
    }

    return appliedLayout
  }

  private bindWritingArea(writeEl: HTMLElement): void {
    this.observer?.disconnect()
    this.clearWriteOverrides(this.writeEl)
    this.writeEl = writeEl
    this.observer?.observe(writeEl, { attributes: true, attributeFilter: ['class'] })
  }

  private clearWriteOverrides(writeEl: HTMLElement | null): void {
    if (!writeEl) return
    delete writeEl.dataset.tplWiderMode
    writeEl.style.removeProperty('--tpl-wider-shell-gutter')
    writeEl.style.removeProperty('--tpl-wider-content-width')
    writeEl.style.removeProperty('--tpl-wider-max-width')
    writeEl.style.removeProperty('width')
    writeEl.style.removeProperty('max-width')
  }

  private findActiveWritingArea(): HTMLElement | null {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('#write'))
    let active: HTMLElement | null = null
    let largestArea = 0

    for (const candidate of candidates) {
      if (!candidate.isConnected) continue
      const style = getComputedStyle(candidate)
      if (style.display === 'none' || style.visibility === 'hidden') continue

      const rect = candidate.getBoundingClientRect()
      const area = Math.max(0, rect.width) * Math.max(0, rect.height)
      if (area <= largestArea) continue
      active = candidate
      largestArea = area
    }

    return active ?? candidates.find(candidate => candidate.isConnected) ?? null
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

const WIDER_CSS = /* css */ `
/* Outrank ordinary theme #write rules regardless of stylesheet insertion order. */
html #write[data-tpl-wider-mode],
html #typora-source {
  box-sizing: border-box;
  width: min(
    calc(100vw - (var(--tpl-wider-shell-gutter, 24px) * 2)),
    var(--tpl-wider-max-width, 860px)
  );
  max-width: var(--tpl-wider-max-width, 860px);
  transition: padding-right 180ms ease;
}

/* Typora base.css sets width:inherit on h1-h6, p, pre inside #write.
   With border-box on #write, children inherit the border-box width but
   apply it as content-box, causing overflow. Reset to normal block flow. */
#write[data-tpl-wider-mode] h1,
#write[data-tpl-wider-mode] h2,
#write[data-tpl-wider-mode] h3,
#write[data-tpl-wider-mode] h4,
#write[data-tpl-wider-mode] h5,
#write[data-tpl-wider-mode] h6,
#write[data-tpl-wider-mode] p,
#write[data-tpl-wider-mode] pre {
  width: auto;
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
