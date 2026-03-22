/**
 * Plugin Center panel — modal overlay showing tpl status and plugin management.
 * Pure DOM, no framework. CSS scoped under #tpl-plugin-center.
 */

import type { PluginManager } from '../plugin/manager.js'
import type { HotkeyManager } from '../hotkey/manager.js'
import { themeVars } from './theme.js'

const ID = 'tpl-plugin-center'
const VERSION = '0.1.0'

function esc(text: string): string {
  return text.replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!
  )
}

export class PluginCenterPanel {
  private el: HTMLElement | null = null
  private styleEl: HTMLStyleElement | null = null
  private plugins: PluginManager
  private hotkeys: HotkeyManager

  constructor(plugins: PluginManager, hotkeys: HotkeyManager) {
    this.plugins = plugins
    this.hotkeys = hotkeys
  }

  get isOpen(): boolean {
    return this.el !== null
  }

  toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  open(): void {
    if (this.el) return
    this.injectStyle()
    this.el = this.render()
    document.body.appendChild(this.el)
    const panel = this.el.querySelector(`.${ID}-panel`) as HTMLElement | null
    panel?.focus()
  }

  close(): void {
    this.el?.remove()
    this.el = null
    this.styleEl?.remove()
    this.styleEl = null
  }

  private render(): HTMLElement {
    const overlay = document.createElement('div')
    overlay.id = ID
    overlay.innerHTML = /* html */ `
      <div class="${ID}-panel" tabindex="-1">
        <div class="${ID}-header">
          <span class="${ID}-title">typora-plugin-lite</span>
          <span class="${ID}-version">v${VERSION}</span>
        </div>
        <hr class="${ID}-divider" />
        <div class="${ID}-list">${this.renderPlugins()}</div>
        <hr class="${ID}-divider" />
        <div class="${ID}-footer">
          <div class="${ID}-hotkeys">Hotkeys: ${this.renderHotkeyList()}</div>
          <div class="${ID}-hint">Press Escape or ${navigator.platform.includes('Mac') ? '\u2318\u0060' : 'Ctrl+\u0060'} to close</div>
        </div>
      </div>
    `

    // Close on Escape
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close() }
    })

    // Close on backdrop click + toggle buttons via event delegation
    overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target === overlay) { this.close(); return }

      const btn = target.closest<HTMLButtonElement>(`.${ID}-toggle`)
      if (!btn) return
      const pluginId = btn.dataset.pluginId!
      if (this.plugins.isLoaded(pluginId)) {
        this.plugins.disablePlugin(pluginId)
        this.refresh()
      } else {
        this.plugins.enablePlugin(pluginId).then(() => this.refresh())
      }
    })

    return overlay
  }

  private renderPlugins(): string {
    const manifests = this.plugins.getManifests()
    if (manifests.length === 0) {
      return `<div class="${ID}-empty">No plugins found</div>`
    }
    return manifests.map(m => {
      const loaded = this.plugins.isLoaded(m.id)
      const dot = loaded ? '\u25cf' : '\u25cb'
      const statusClass = loaded ? 'on' : 'off'
      const label = loaded ? 'ON' : 'OFF'
      const trigger = this.describeTrigger(m.loading)
      return /* html */ `
        <div class="${ID}-row">
          <div class="${ID}-row-main">
            <span class="${ID}-dot ${ID}-dot-${statusClass}">${dot}</span>
            <span class="${ID}-name">${esc(m.name)}</span>
            <span class="${ID}-plugin-version">v${esc(m.version)}</span>
            <button class="${ID}-toggle ${ID}-toggle-${statusClass}" data-plugin-id="${esc(m.id)}">${label}</button>
          </div>
          <div class="${ID}-row-meta">
            ${m.description ? `<span class="${ID}-desc">${esc(m.description)}</span>` : ''}
            ${trigger ? `<span class="${ID}-trigger">${esc(trigger)}</span>` : ''}
          </div>
        </div>
      `
    }).join('')
  }

  private describeTrigger(loading: import('../plugin/manifest.js').LoadingStrategy): string {
    if (loading.startup) return 'startup'
    if (loading.hotkey?.length) {
      return loading.hotkey.map(k => this.formatHotkey(k)).join(' / ')
    }
    if (loading.event?.length) return loading.event.join(', ')
    return ''
  }

  private formatHotkey(key: string): string {
    if (!navigator.platform.includes('Mac')) return key
    return key
      .replace(/Mod\+/gi, '\u2318')
      .replace(/Shift\+/gi, '\u21e7')
      .replace(/Alt\+/gi, '\u2325')
      .replace(/ArrowUp/gi, '\u2191')
      .replace(/ArrowDown/gi, '\u2193')
      .replace(/Space/gi, 'Space')
  }

  private renderHotkeyList(): string {
    const bindings = this.hotkeys.getBindings()
    if (bindings.length === 0) return 'none'
    return bindings.map(b => esc(this.formatHotkey(b.key))).join(' \u00a0 ')
  }

  private refresh(): void {
    if (!this.el) return
    const list = this.el.querySelector(`.${ID}-list`)
    if (list) list.innerHTML = this.renderPlugins()
  }

  private injectStyle(): void {
    if (this.styleEl) return
    this.styleEl = document.createElement('style')
    this.styleEl.textContent = `
      #${ID} {
        all: initial;
        ${themeVars()}
        position: fixed;
        inset: 0;
        z-index: 100000;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.4);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        color: var(--tpl-text);
      }

      .${ID}-panel {
        background: var(--tpl-bg);
        border: 1px solid var(--tpl-border);
        border-radius: 10px;
        padding: 20px 24px;
        min-width: 380px;
        max-width: 480px;
        max-height: 80vh;
        overflow-y: auto;
        outline: none;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
      }

      .${ID}-header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }

      .${ID}-title {
        font-size: 15px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }

      .${ID}-version {
        font-size: 12px;
        color: var(--tpl-text-muted);
      }

      .${ID}-divider {
        border: none;
        border-top: 1px solid var(--tpl-border);
        margin: 12px 0;
      }

      .${ID}-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .${ID}-row {
        padding: 8px 10px;
        border-radius: 6px;
        transition: background 0.15s;
      }

      .${ID}-row:hover {
        background: var(--tpl-hover);
      }

      .${ID}-row-main {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .${ID}-dot { font-size: 10px; }
      .${ID}-dot-on { color: var(--tpl-toggle-on); }
      .${ID}-dot-off { color: var(--tpl-toggle-off); }

      .${ID}-name {
        font-weight: 500;
        flex: 1;
      }

      .${ID}-plugin-version {
        font-size: 11px;
        color: var(--tpl-text-muted);
        margin-right: 8px;
      }

      .${ID}-toggle {
        all: unset;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        padding: 2px 10px;
        border-radius: 4px;
        letter-spacing: 0.03em;
        transition: all 0.15s;
      }

      .${ID}-toggle-on {
        background: var(--tpl-toggle-on);
        color: #fff;
      }

      .${ID}-toggle-off {
        background: var(--tpl-toggle-off);
        color: #fff;
      }

      .${ID}-toggle:hover { opacity: 0.85; }

      .${ID}-row-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-top: 4px;
        padding-left: 18px;
      }

      .${ID}-desc {
        font-size: 12px;
        color: var(--tpl-text-muted);
      }

      .${ID}-trigger {
        font-size: 11px;
        color: var(--tpl-accent);
        font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
      }

      .${ID}-footer {
        font-size: 12px;
        color: var(--tpl-text-muted);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .${ID}-empty {
        text-align: center;
        color: var(--tpl-text-muted);
        padding: 16px 0;
      }
    `
    document.head.appendChild(this.styleEl)
  }
}
