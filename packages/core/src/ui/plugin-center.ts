/**
 * Plugin Center panel — modal overlay showing tpl status, plugin toggles,
 * and per-plugin settings in a master-detail layout.
 *
 * Architecture:
 *   - Left pane (35%): plugin list with ON/OFF toggle + selection highlight.
 *   - Right pane (65%): settings form rendered via plugin-settings-renderer.
 *   - CSS scoped under #tpl-plugin-center + .tpl-pc-* class prefix.
 *
 * Pure DOM, no framework. CSS lives inline in a <style> tag injected on open.
 */

import type { PluginManager } from '../plugin/manager.js'
import type { HotkeyManager } from '../hotkey/manager.js'
import type { Plugin } from '../plugin/plugin.js'
import type { PluginManifest } from '../plugin/manifest.js'
import type { SettingsSchema } from '../plugin/settings-schema.js'
import { PluginSettings } from '../plugin/settings.js'
import { platform } from '../platform/index.js'
import { themeVars } from './theme.js'
import { renderSettings, destroyRender, type RenderContext } from './plugin-settings-renderer.js'

const ID = 'tpl-plugin-center'
const VERSION = '0.1.0'

function esc(text: string): string {
  return text.replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!
  )
}

interface PluginClassLike {
  settingsSchema?: SettingsSchema<Record<string, unknown>>
  defaultSettings?: Record<string, unknown>
}

export class PluginCenterPanel {
  private el: HTMLElement | null = null
  private styleEl: HTMLStyleElement | null = null
  private plugins: PluginManager
  private hotkeys: HotkeyManager
  private selectedId: string | null = null
  private currentDetailEl: HTMLElement | null = null

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

    const manifests = this.plugins.getManifests()
    if (!this.selectedId && manifests.length > 0) {
      this.selectedId = manifests[0].id
    }

    this.el = this.render()
    document.body.appendChild(this.el)
    const panel = this.el.querySelector(`.${ID}-panel`) as HTMLElement | null
    panel?.focus()
  }

  close(): void {
    if (this.currentDetailEl) {
      destroyRender(this.currentDetailEl)
      this.currentDetailEl = null
    }
    this.el?.remove()
    this.el = null
    this.styleEl?.remove()
    this.styleEl = null
  }

  // ---- Rendering ------------------------------------------------------

  private render(): HTMLElement {
    const overlay = document.createElement('div')
    overlay.id = ID

    const panel = document.createElement('div')
    panel.className = `${ID}-panel`
    panel.tabIndex = -1

    // Header
    const header = document.createElement('div')
    header.className = `${ID}-header`
    const titleSpan = document.createElement('span')
    titleSpan.className = `${ID}-title`
    titleSpan.textContent = 'typora-plugin-lite'
    const versionSpan = document.createElement('span')
    versionSpan.className = `${ID}-version`
    versionSpan.textContent = `v${VERSION}`
    header.appendChild(titleSpan)
    header.appendChild(versionSpan)
    panel.appendChild(header)

    // Body: split columns
    const body = document.createElement('div')
    body.className = `${ID}-body`
    const listPane = document.createElement('div')
    listPane.className = `${ID}-list-pane`
    this.renderListInto(listPane)
    const detailPane = document.createElement('div')
    detailPane.className = `${ID}-detail-pane`
    this.renderDetailInto(detailPane)
    body.appendChild(listPane)
    body.appendChild(detailPane)
    panel.appendChild(body)

    // Footer
    const footer = document.createElement('div')
    footer.className = `${ID}-footer`
    const hotkeysEl = document.createElement('div')
    hotkeysEl.className = `${ID}-hotkeys`
    hotkeysEl.textContent = `Hotkeys: ${this.renderHotkeyList()}`
    const hintEl = document.createElement('div')
    hintEl.className = `${ID}-hint`
    hintEl.textContent = `Esc or ${navigator.userAgent.includes('Mac') ? '\u2318\u0060' : 'Ctrl+\u0060'} to close`
    footer.appendChild(hotkeysEl)
    footer.appendChild(hintEl)
    panel.appendChild(footer)

    overlay.appendChild(panel)

    // Overlay-level listeners
    overlay.addEventListener('keydown', (e) => this.handleKeydown(e as KeyboardEvent))
    overlay.addEventListener('click', (e) => this.handleClick(e as MouseEvent))

    return overlay
  }

  private renderListInto(container: HTMLElement): void {
    container.replaceChildren()
    const manifests = this.plugins.getManifests()
    if (manifests.length === 0) {
      const empty = document.createElement('div')
      empty.className = `${ID}-empty`
      empty.textContent = 'No plugins found'
      container.appendChild(empty)
      return
    }

    for (const m of manifests) {
      container.appendChild(this.makeRow(m))
    }
  }

  private makeRow(m: PluginManifest): HTMLElement {
    const loaded = this.plugins.isLoaded(m.id)
    const selected = this.selectedId === m.id

    const row = document.createElement('div')
    row.className = `${ID}-row${selected ? ` ${ID}-row-active` : ''}`
    row.dataset.pluginId = m.id
    row.tabIndex = 0

    const main = document.createElement('div')
    main.className = `${ID}-row-main`

    const dot = document.createElement('span')
    dot.className = `${ID}-dot ${ID}-dot-${loaded ? 'on' : 'off'}`
    dot.textContent = loaded ? '\u25cf' : '\u25cb'

    const name = document.createElement('span')
    name.className = `${ID}-name`
    name.textContent = m.name

    const pluginVersion = document.createElement('span')
    pluginVersion.className = `${ID}-plugin-version`
    pluginVersion.textContent = `v${m.version}`

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = `${ID}-toggle ${ID}-toggle-${loaded ? 'on' : 'off'}`
    toggle.dataset.pluginId = m.id
    toggle.textContent = loaded ? 'ON' : 'OFF'

    main.appendChild(dot)
    main.appendChild(name)
    main.appendChild(pluginVersion)
    main.appendChild(toggle)
    row.appendChild(main)

    // Optional description/trigger meta line
    const trigger = this.describeTrigger(m.loading)
    if (m.description || trigger) {
      const meta = document.createElement('div')
      meta.className = `${ID}-row-meta`
      if (m.description) {
        const desc = document.createElement('span')
        desc.className = `${ID}-desc`
        desc.textContent = m.description
        meta.appendChild(desc)
      }
      if (trigger) {
        const trg = document.createElement('span')
        trg.className = `${ID}-trigger`
        trg.textContent = trigger
        meta.appendChild(trg)
      }
      row.appendChild(meta)
    }
    return row
  }

  private renderDetailInto(container: HTMLElement): void {
    container.replaceChildren()
    if (this.currentDetailEl) {
      destroyRender(this.currentDetailEl)
      this.currentDetailEl = null
    }

    if (!this.selectedId) {
      const idle = document.createElement('div')
      idle.className = `${ID}-detail-idle`
      idle.textContent = 'Select a plugin on the left.'
      container.appendChild(idle)
      return
    }

    const manifest = this.plugins.getManifests().find(m => m.id === this.selectedId)
    if (!manifest) return

    const resolved = this.resolveSettingsContext(manifest)
    if (!resolved) {
      // Plugin exists but has no schema — render lightweight placeholder.
      const ctx: RenderContext<Record<string, unknown>> = {
        settings: new PluginSettings(manifest.id, {}, platform),
        schema: { fields: {} },
        pluginName: manifest.name,
        pluginVersion: manifest.version,
        pluginDescription: manifest.description,
        isLoaded: this.plugins.isLoaded(manifest.id),
      }
      const el = renderSettings(ctx)
      container.appendChild(el)
      this.currentDetailEl = el
      return
    }

    const el = renderSettings({
      ...resolved,
      pluginName: manifest.name,
      pluginVersion: manifest.version,
      pluginDescription: manifest.description,
    })
    container.appendChild(el)
    this.currentDetailEl = el
  }

  /**
   * Resolve the schema + settings instance for a plugin, preferring the live
   * instance when loaded. For unloaded plugins we still attempt to read the
   * class from the global registry set by IIFE plugin bundles; if missing
   * (lazy plugin not yet triggered), returns null → placeholder is shown.
   */
  private resolveSettingsContext(manifest: PluginManifest): {
    settings: PluginSettings<Record<string, unknown>>
    schema: SettingsSchema<Record<string, unknown>>
    isLoaded: boolean
  } | null {
    const instance = this.plugins.getPlugin(manifest.id)
    const cls = this.getPluginClass(manifest.id, instance)
    const schema = cls?.settingsSchema
    if (!schema || !schema.fields || Object.keys(schema.fields).length === 0) return null

    if (instance) {
      return {
        settings: instance.settings as PluginSettings<Record<string, unknown>>,
        schema,
        isLoaded: true,
      }
    }

    // Unloaded: construct a detached PluginSettings against the declared defaults.
    const defaults = cls?.defaultSettings ?? {}
    const settings = new PluginSettings(manifest.id, defaults, platform)
    return { settings, schema, isLoaded: false }
  }

  private getPluginClass(id: string, instance: Plugin | null): PluginClassLike | null {
    if (instance) return instance.constructor as unknown as PluginClassLike
    const registry = (window as any).__tpl?.pluginClasses as Record<string, PluginClassLike> | undefined
    return registry?.[id] ?? null
  }

  // ---- Event routing --------------------------------------------------

  private handleClick(e: MouseEvent): void {
    const target = e.target as HTMLElement
    if (!this.el) return

    // Backdrop click
    if (target === this.el) {
      this.close()
      return
    }

    // Toggle button — do NOT bubble into selection
    const toggleBtn = target.closest<HTMLButtonElement>(`.${ID}-toggle`)
    if (toggleBtn) {
      e.stopPropagation()
      const id = toggleBtn.dataset.pluginId!
      if (this.plugins.isLoaded(id)) {
        this.plugins.disablePlugin(id)
        this.refresh()
      } else {
        void this.plugins.enablePlugin(id).then(() => this.refresh())
      }
      return
    }

    // Row selection
    const row = target.closest<HTMLElement>(`.${ID}-row`)
    if (row && row.dataset.pluginId) {
      this.selectPlugin(row.dataset.pluginId)
    }
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      this.close()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const ids = this.plugins.getManifests().map(m => m.id)
      if (ids.length === 0) return
      const currentIdx = this.selectedId ? ids.indexOf(this.selectedId) : -1
      const nextIdx = e.key === 'ArrowDown'
        ? (currentIdx + 1) % ids.length
        : (currentIdx - 1 + ids.length) % ids.length
      e.preventDefault()
      this.selectPlugin(ids[nextIdx])
      const row = this.el?.querySelector<HTMLElement>(`.${ID}-row[data-plugin-id="${esc(ids[nextIdx])}"]`)
      row?.focus()
      return
    }
    if (e.key === 'Enter') {
      // If focus is on a row, jump into detail pane's first focusable
      const activeRow = (e.target as HTMLElement)?.closest?.(`.${ID}-row`)
      if (activeRow) {
        e.preventDefault()
        const firstField = this.el?.querySelector<HTMLElement>(
          '.tpl-pc-detail input, .tpl-pc-detail select, .tpl-pc-detail button:not(.tpl-pc-btn-quiet), .tpl-pc-toggle',
        )
        firstField?.focus()
      }
    }
  }

  private selectPlugin(id: string): void {
    if (this.selectedId === id) return
    this.selectedId = id
    // Update row highlights without full re-render of list DOM
    const list = this.el?.querySelector<HTMLElement>(`.${ID}-list-pane`)
    if (list) {
      for (const row of list.querySelectorAll<HTMLElement>(`.${ID}-row`)) {
        row.classList.toggle(`${ID}-row-active`, row.dataset.pluginId === id)
      }
    }
    const detail = this.el?.querySelector<HTMLElement>(`.${ID}-detail-pane`)
    if (detail) this.renderDetailInto(detail)
  }

  private refresh(): void {
    if (!this.el) return
    const list = this.el.querySelector<HTMLElement>(`.${ID}-list-pane`)
    if (list) this.renderListInto(list)
    const detail = this.el.querySelector<HTMLElement>(`.${ID}-detail-pane`)
    if (detail) this.renderDetailInto(detail)
  }

  // ---- Meta -----------------------------------------------------------

  private describeTrigger(loading: import('../plugin/manifest.js').LoadingStrategy): string {
    if (loading.startup) return 'startup'
    if (loading.hotkey?.length) {
      return loading.hotkey.map(k => this.formatHotkey(k)).join(' / ')
    }
    if (loading.event?.length) return loading.event.join(', ')
    return ''
  }

  private formatHotkey(key: string): string {
    if (!navigator.userAgent.includes('Mac')) return key
    return key
      .replace(/Mod\+/gi, '\u2318')
      .replace(/Shift\+/gi, '\u21e7')
      .replace(/Alt\+/gi, '\u2325')
      .replace(/ArrowUp/gi, '\u2191')
      .replace(/ArrowDown/gi, '\u2193')
  }

  private renderHotkeyList(): string {
    const bindings = this.hotkeys.getBindings()
    if (bindings.length === 0) return 'none'
    return bindings.map(b => this.formatHotkey(b.key)).join(' \u00a0 ')
  }

  // ---- Styles ---------------------------------------------------------

  private injectStyle(): void {
    if (this.styleEl) return
    this.styleEl = document.createElement('style')
    this.styleEl.textContent = CSS_BASE + CSS_LIST + CSS_DETAIL + CSS_FIELDS
    document.head.appendChild(this.styleEl)
    // theme vars are per-instance (dark mode may toggle between opens)
    const themeTag = document.createElement('style')
    themeTag.dataset.tplPluginCenterTheme = ''
    themeTag.textContent = `#${ID} { ${themeVars()} }`
    document.head.appendChild(themeTag)
    // Attach theme tag to the same disposable cycle
    const outer = this.styleEl
    const origRemove = outer.remove.bind(outer)
    outer.remove = () => { themeTag.remove(); origRemove() }
  }
}

// ---- CSS ---------------------------------------------------------------

const CSS_BASE = `
#tpl-plugin-center {
  all: initial;
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
.tpl-plugin-center-panel {
  background: var(--tpl-bg);
  border: 1px solid var(--tpl-border);
  border-radius: 12px;
  width: min(820px, 92vw);
  height: min(560px, 86vh);
  display: flex;
  flex-direction: column;
  outline: none;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  overflow: hidden;
}
.tpl-plugin-center-header {
  padding: 14px 18px 10px;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  border-bottom: 1px solid var(--tpl-panel-split);
}
.tpl-plugin-center-title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.tpl-plugin-center-version { font-size: 12px; color: var(--tpl-text-muted); }
.tpl-plugin-center-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(220px, 36%) 1fr;
  min-height: 0;
}
.tpl-plugin-center-footer {
  padding: 8px 18px 10px;
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--tpl-text-muted);
  border-top: 1px solid var(--tpl-panel-split);
}
.tpl-plugin-center-hotkeys { font-family: var(--tpl-mono); }
`

const CSS_LIST = `
.tpl-plugin-center-list-pane {
  border-right: 1px solid var(--tpl-panel-split);
  overflow-y: auto;
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tpl-plugin-center-empty { padding: 20px 10px; text-align: center; color: var(--tpl-text-muted); }
.tpl-plugin-center-row {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  outline: none;
  transition: background 0.12s;
}
.tpl-plugin-center-row:hover { background: var(--tpl-hover); }
.tpl-plugin-center-row:focus-visible { box-shadow: inset 0 0 0 2px var(--tpl-accent); }
.tpl-plugin-center-row-active { background: var(--tpl-active); }
.tpl-plugin-center-row-active:hover { background: var(--tpl-active); }
.tpl-plugin-center-row-main { display: flex; align-items: center; gap: 8px; }
.tpl-plugin-center-dot { font-size: 10px; width: 10px; text-align: center; }
.tpl-plugin-center-dot-on { color: var(--tpl-toggle-on); }
.tpl-plugin-center-dot-off { color: var(--tpl-toggle-off); }
.tpl-plugin-center-name { font-weight: 500; flex: 1; }
.tpl-plugin-center-plugin-version { font-size: 11px; color: var(--tpl-text-muted); }
.tpl-plugin-center-toggle {
  all: unset;
  cursor: pointer;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 4px;
  letter-spacing: 0.03em;
  transition: opacity 0.15s;
}
.tpl-plugin-center-toggle-on { background: var(--tpl-toggle-on); color: #fff; }
.tpl-plugin-center-toggle-off { background: var(--tpl-toggle-off); color: #fff; }
.tpl-plugin-center-toggle:hover { opacity: 0.85; }
.tpl-plugin-center-row-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
  padding-left: 20px;
}
.tpl-plugin-center-desc { font-size: 12px; color: var(--tpl-text-muted); }
.tpl-plugin-center-trigger { font-size: 11px; color: var(--tpl-accent); font-family: var(--tpl-mono); }
`

const CSS_DETAIL = `
.tpl-plugin-center-detail-pane {
  overflow-y: auto;
  padding: 18px 22px;
}
.tpl-plugin-center-detail-idle {
  color: var(--tpl-text-muted);
  padding: 24px 8px;
  text-align: center;
}
.tpl-pc-detail { display: flex; flex-direction: column; gap: 12px; }
.tpl-pc-detail-header { display: flex; flex-direction: column; gap: 4px; }
.tpl-pc-detail-title { display: flex; align-items: baseline; gap: 8px; }
.tpl-pc-detail-name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.tpl-pc-detail-version { font-size: 11px; color: var(--tpl-text-muted); font-family: var(--tpl-mono); }
.tpl-pc-detail-desc { font-size: 12px; color: var(--tpl-text-muted); }
.tpl-pc-banner {
  padding: 8px 12px;
  background: var(--tpl-muted-bg);
  border: 1px solid var(--tpl-field-border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--tpl-text-muted);
}
.tpl-pc-empty-schema {
  padding: 40px 12px;
  text-align: center;
  color: var(--tpl-text-muted);
  font-size: 13px;
}
.tpl-pc-sections { display: flex; flex-direction: column; gap: 18px; }
.tpl-pc-section { display: flex; flex-direction: column; gap: 10px; }
.tpl-pc-section-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--tpl-text-muted);
}
.tpl-pc-fields { display: flex; flex-direction: column; gap: 14px; }
`

const CSS_FIELDS = `
.tpl-pc-field { display: flex; flex-direction: column; gap: 6px; }
.tpl-pc-field-header { display: flex; justify-content: space-between; align-items: center; }
.tpl-pc-field-label { font-size: 13px; font-weight: 500; }
.tpl-pc-field-status {
  font-size: 12px;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tpl-pc-field-status.tpl-pc-saving { color: var(--tpl-text-muted); animation: tpl-pc-spin 0.8s linear infinite; }
.tpl-pc-field-status.tpl-pc-saved  { color: var(--tpl-success); }
.tpl-pc-field-status.tpl-pc-error  { color: var(--tpl-danger); }
@keyframes tpl-pc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.tpl-pc-field-desc { font-size: 12px; color: var(--tpl-text-muted); line-height: 1.4; }
.tpl-pc-field-error { font-size: 11px; color: var(--tpl-danger); display: none; }
.tpl-pc-field-control { display: flex; }

/* text / number inputs */
.tpl-pc-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  background: var(--tpl-field-bg);
  border: 1px solid var(--tpl-field-border);
  border-radius: 6px;
  color: var(--tpl-text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.12s, background 0.12s;
}
.tpl-pc-input:focus { border-color: var(--tpl-field-focus); }
.tpl-pc-input-mono { font-family: var(--tpl-mono); font-size: 12.5px; }
.tpl-pc-input-wrap {
  display: flex;
  flex: 1;
  background: var(--tpl-field-bg);
  border: 1px solid var(--tpl-field-border);
  border-radius: 6px;
  overflow: hidden;
}
.tpl-pc-input-wrap:focus-within { border-color: var(--tpl-field-focus); }
.tpl-pc-input-wrap .tpl-pc-input {
  border: none;
  background: transparent;
}
.tpl-pc-input-prefix {
  display: flex;
  align-items: center;
  padding: 0 10px;
  color: var(--tpl-text-muted);
  background: var(--tpl-muted-bg);
  border-right: 1px solid var(--tpl-field-border);
}

/* select */
.tpl-pc-select {
  flex: 1;
  padding: 6px 10px;
  background: var(--tpl-field-bg);
  border: 1px solid var(--tpl-field-border);
  border-radius: 6px;
  color: var(--tpl-text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}
.tpl-pc-select:focus { border-color: var(--tpl-field-focus); }

/* segmented */
.tpl-pc-segmented {
  display: flex;
  background: var(--tpl-muted-bg);
  border: 1px solid var(--tpl-field-border);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
}
.tpl-pc-segmented-opt {
  all: unset;
  flex: 1;
  text-align: center;
  padding: 5px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  color: var(--tpl-text-muted);
  transition: background 0.12s, color 0.12s;
}
.tpl-pc-segmented-opt:hover { color: var(--tpl-text); }
.tpl-pc-segmented-opt-active {
  background: var(--tpl-bg);
  color: var(--tpl-text);
  font-weight: 500;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}

/* toggle switch */
.tpl-pc-toggle {
  all: unset;
  position: relative;
  width: 34px;
  height: 18px;
  background: var(--tpl-toggle-off);
  border-radius: 9999px;
  cursor: pointer;
  transition: background 0.15s;
}
.tpl-pc-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.15s, background 0.15s;
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
}
.tpl-pc-toggle-on { background: var(--tpl-toggle-on); }
.tpl-pc-toggle-on .tpl-pc-toggle-knob { transform: translateX(16px); }
.tpl-pc-toggle-dangerous { box-shadow: 0 0 0 2px rgba(229, 72, 77, 0.25); }

/* secret */
.tpl-pc-secret-wrap { display: flex; gap: 8px; flex: 1; align-items: center; }
.tpl-pc-secret-wrap .tpl-pc-input { flex: 1; }
.tpl-pc-secret-actions { display: flex; gap: 6px; }

/* buttons */
.tpl-pc-btn {
  all: unset;
  cursor: pointer;
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  color: var(--tpl-text);
  background: var(--tpl-muted-bg);
  border: 1px solid var(--tpl-field-border);
  transition: background 0.12s, border-color 0.12s;
}
.tpl-pc-btn:hover { background: var(--tpl-hover); }
.tpl-pc-btn-quiet { background: transparent; }
.tpl-pc-btn-success { background: var(--tpl-success); color: #fff; border-color: var(--tpl-success); }
`
