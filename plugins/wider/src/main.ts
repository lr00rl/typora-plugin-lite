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
  private shellEl: HTMLElement | null = null
  private triggerEl: HTMLButtonElement | null = null
  private controlEl: HTMLElement | null = null
  private observer: MutationObserver | null = null
  private currentMode: WiderMode = 'default'

  onload(): void {
    this.writeEl = document.getElementById('write')
    if (!this.writeEl) return

    this.registerCss(WIDER_CSS)
    this.currentMode = this.resolveInitialMode()

    this.mountControl()
    this.registerWidthCommands()
    this.registerHotkey('Mod+[', () => this.stepMode(-1))
    this.registerHotkey('Mod+]', () => this.stepMode(+1))
    this.registerDomEvent(document, 'keydown', (event) => this.handleEditorHotkey(event as KeyboardEvent), { capture: true })
    this.registerDomEvent(window, 'resize', () => this.handleViewportChange())

    this.observer = new MutationObserver(() => this.applyMode(this.currentMode, false))
    this.observer.observe(this.writeEl, { attributes: true, attributeFilter: ['class'] })
    this.addDisposable(() => this.observer?.disconnect())

    this.applyMode(this.currentMode, false)
  }

  onunload(): void {
    this.shellEl?.remove()
    this.triggerEl?.remove()
    this.controlEl?.remove()
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

  private mountControl(): void {
    const shell = document.createElement('div')
    shell.id = 'tpl-wider-shell'

    const trigger = document.createElement('button')
    trigger.id = 'tpl-wider-trigger'
    trigger.type = 'button'
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'false')

    const el = document.createElement('div')
    el.id = 'tpl-wider-control'
    el.innerHTML = MODE_ORDER.map(mode => (
      `<button type="button" class="tpl-wider-btn" data-mode="${mode}" aria-pressed="false">${MODE_LABELS[mode]}</button>`
    )).join('')

    this.registerDomEvent(shell, 'mouseenter', () => trigger.setAttribute('aria-expanded', 'true'))
    this.registerDomEvent(shell, 'mouseleave', () => trigger.setAttribute('aria-expanded', 'false'))
    this.registerDomEvent(shell, 'focusin', () => trigger.setAttribute('aria-expanded', 'true'))
    this.registerDomEvent(shell, 'focusout', () => {
      window.setTimeout(() => {
        if (!shell.matches(':focus-within')) {
          trigger.setAttribute('aria-expanded', 'false')
        }
      }, 0)
    })

    this.registerDomEvent(el, 'click', (event) => {
      const target = event.target as HTMLElement | null
      const button = target?.closest<HTMLButtonElement>('.tpl-wider-btn[data-mode]')
      const mode = button?.dataset.mode
      if (!isWiderMode(mode)) return
      this.setMode(mode, true)
    })

    shell.appendChild(trigger)
    shell.appendChild(el)
    document.body.appendChild(shell)
    this.shellEl = shell
    this.triggerEl = trigger
    this.controlEl = el
    this.addDisposable(() => {
      shell.remove()
      this.shellEl = null
      trigger.remove()
      this.triggerEl = null
      el.remove()
      this.controlEl = null
    })
    this.syncControlPlacement()
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

    this.syncControlPlacement()
    this.updateControlState()
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
    this.syncControlPlacement()
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

  private syncControlPlacement(): void {
    if (!this.shellEl || !this.writeEl) return

    if (this.shellEl.parentElement !== document.body) {
      document.body.appendChild(this.shellEl)
    }

    this.shellEl.dataset.tplDock = 'statusbar'

    const contentHost = this.findContentHost()
    const contentRect = contentHost?.getBoundingClientRect()
    const rightOffset = contentRect
      ? clamp(Math.round(window.innerWidth - contentRect.right + 10), 8, 40)
      : 10
    const bottomOffset = contentRect
      ? clamp(Math.round(window.innerHeight - contentRect.bottom), 0, 32)
      : 0

    this.shellEl.style.right = `${rightOffset}px`
    this.shellEl.style.bottom = `${bottomOffset}px`
    this.shellEl.style.removeProperty('top')
    this.shellEl.style.removeProperty('left')
  }

  private findContentHost(): HTMLElement | null {
    return document.querySelector<HTMLElement>('content')
  }

  private updateControlState(): void {
    if (!this.controlEl) return
    const buttons = this.controlEl.querySelectorAll<HTMLButtonElement>('.tpl-wider-btn')
    for (const button of buttons) {
      const active = button.dataset.mode === this.currentMode
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    }

    if (this.triggerEl) {
      this.triggerEl.textContent = `Width · ${MODE_LABELS[this.currentMode]}`
      this.triggerEl.dataset.mode = this.currentMode
    }
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

#tpl-wider-shell {
  z-index: 99990;
}

#tpl-wider-shell[data-tpl-dock="statusbar"] {
  position: fixed;
  display: inline-flex;
  align-items: flex-end;
  -webkit-app-region: no-drag;
  width: 100px;
}

#tpl-wider-trigger {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--item-hover-text-color, var(--text-color, #4f4f4f));
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: opacity 180ms ease, background 180ms ease, color 180ms ease;
}

#tpl-wider-shell[data-tpl-dock="statusbar"] #tpl-wider-trigger {
  width: 100%;
  min-height: 28px;
  padding: 5px 10px 6px;
  border-radius: 7px 7px 0 0;
  background: var(--active-file-bg-color, rgba(127, 127, 127, 0.14));
  border: 1px solid rgba(127, 127, 127, 0.18);
  border-bottom: 0;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.08);
  opacity: 0.92;
}

#tpl-wider-shell[data-tpl-dock="statusbar"] #tpl-wider-trigger:hover,
#tpl-wider-shell[data-tpl-dock="statusbar"]:focus-within #tpl-wider-trigger {
  background: rgba(127, 127, 127, 0.2);
}

#tpl-wider-control {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  min-width: 0;
  padding: 4px;
  box-sizing: border-box;
  border: 1px solid rgba(127, 127, 127, 0.18);
  border-radius: 10px;
  background: var(--side-bar-bg-color, rgba(255, 255, 255, 0.82));
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.14);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  transition: opacity 180ms ease, transform 180ms ease;
}

#tpl-wider-shell[data-tpl-dock="statusbar"] #tpl-wider-control {
  bottom: calc(100% + 8px);
  right: 0;
  opacity: 0;
  transform: translateY(-6px);
  pointer-events: none;
}

#tpl-wider-shell[data-tpl-dock="statusbar"]:hover #tpl-wider-control,
#tpl-wider-shell[data-tpl-dock="statusbar"]:focus-within #tpl-wider-control {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

.tpl-wider-btn {
  appearance: none;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-color, #4f4f4f);
  padding: 6px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
  cursor: pointer;
  text-align: left;
  transition: background 160ms ease, color 160ms ease, transform 160ms ease;
}

.tpl-wider-btn:hover {
  background: rgba(127, 127, 127, 0.08);
}

.tpl-wider-btn.is-active {
  background: var(--active-file-bg-color, rgba(127, 127, 127, 0.14));
  color: var(--active-file-text-color, var(--text-color, #2d2d2d));
  box-shadow: inset 0 0 0 1px rgba(127, 127, 127, 0.14);
}

.tpl-wider-btn:active {
  transform: translateY(1px);
}

@media (max-width: 1023px) {
  #tpl-wider-control {
    max-width: calc(100vw - 24px);
  }

  .tpl-wider-btn {
    padding: 6px 8px;
  }
}
`
