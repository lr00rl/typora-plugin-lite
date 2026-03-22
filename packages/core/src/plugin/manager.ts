/**
 * PluginManager — scans, lazy-loads, and manages plugin lifecycle.
 * Inspired by lazy.nvim: each plugin declares its loading trigger in manifest.json.
 */

import type { PluginManifest } from './manifest.js'
import type { EventBus } from './events.js'
import type { Plugin, TplAppRef } from './plugin.js'
import type { Platform } from '../platform/index.js'
import type { HotkeyManager } from '../hotkey/manager.js'

interface PluginEntry {
  manifest: PluginManifest
  instance: Plugin | null
  loaded: boolean
  loading: boolean
}

interface PluginManagerDeps {
  platform: Platform
  events: EventBus
  hotkeys: HotkeyManager
  editor: unknown
}

export class PluginManager {
  private plugins = new Map<string, PluginEntry>()
  private platform: Platform
  private events: EventBus
  private hotkeys: HotkeyManager
  private appRef: TplAppRef

  constructor(deps: PluginManagerDeps) {
    this.platform = deps.platform
    this.events = deps.events
    this.hotkeys = deps.hotkeys
    this.appRef = { platform: deps.platform, events: deps.events, hotkeys: deps.hotkeys }
  }

  /** Scan plugins directory for manifest.json files, register lazy triggers, then load startup plugins. */
  async scanAndLoad(): Promise<void> {
    const pluginsDir = this.platform.path.join(this.platform.pluginsDir, 'plugins')
    let dirs: string[]
    try {
      dirs = await this.platform.fs.list(pluginsDir)
    } catch {
      console.warn('[tpl] plugins directory not found, skipping scan')
      return
    }

    // Read all manifests
    for (const dir of dirs) {
      try {
        const manifestPath = this.platform.path.join(pluginsDir, dir, 'manifest.json')
        const exists = await this.platform.fs.exists(manifestPath)
        if (!exists) continue
        const text = await this.platform.fs.readText(manifestPath)
        const manifest: PluginManifest = JSON.parse(text)
        this.registerPlugin(manifest)
      } catch (err) {
        console.warn(`[tpl] failed to read manifest for ${dir}:`, err)
      }
    }

    // Load startup plugins
    const startupPlugins = [...this.plugins.entries()]
      .filter(([, entry]) => entry.manifest.loading.startup)
    await Promise.all(startupPlugins.map(([id]) => this.loadPlugin(id)))
  }

  /** Register a plugin manifest and set up lazy loading triggers. */
  private registerPlugin(manifest: PluginManifest): void {
    const entry: PluginEntry = { manifest, instance: null, loaded: false, loading: false }
    this.plugins.set(manifest.id, entry)

    const { loading } = manifest

    // Event-based lazy loading
    if (loading.event?.length) {
      for (const event of loading.event) {
        const lazyHandler = (...args: unknown[]) => {
          this.events.off(event, lazyHandler)
          this.loadPlugin(manifest.id).then(() => {
            // Replay the triggering event after load
            this.events.emit(event, ...args)
          })
        }
        this.events.on(event, lazyHandler)
      }
    }

    // Command-based lazy loading
    if (loading.command?.length) {
      for (const cmd of loading.command) {
        const lazyHandler = () => {
          this.events.off(`command:execute:${cmd}`, lazyHandler)
          this.loadPlugin(manifest.id).then(() => {
            this.events.emit(`command:execute:${cmd}`)
          })
        }
        this.events.on(`command:execute:${cmd}`, lazyHandler)
      }
    }

    // Hotkey-based lazy loading
    if (loading.hotkey?.length) {
      for (const key of loading.hotkey) {
        const lazyHandler = () => {
          this.hotkeys.unregister(key)
          this.loadPlugin(manifest.id).then(() => {
            // The plugin's onload will re-register the hotkey with its real handler
          })
        }
        this.hotkeys.register(key, lazyHandler)
      }
    }
  }

  /**
   * Load a plugin by injecting a <script> tag.
   * The plugin script registers its class on window.__tpl.pluginClasses[id].
   * WKWebView blocks file:// ESM import(), so we use <script> injection.
   */
  async loadPlugin(id: string): Promise<void> {
    const entry = this.plugins.get(id)
    if (!entry || entry.loaded || entry.loading) return

    entry.loading = true
    const TAG = '[tpl:manager]'
    const mainFile = entry.manifest.main ?? 'main.js'

    // Build file:// URL with %20 for spaces
    const pluginPath = `${this.platform.pluginsDir}/plugins/${id}/${mainFile}`
    const pluginUrl = 'file://' + pluginPath.replace(/ /g, '%20')

    try {
      console.log(TAG, `loading plugin: ${id} from ${pluginUrl}`)

      // Load via <script> tag
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.src = pluginUrl
        s.onload = () => resolve()
        s.onerror = (e) => reject(new Error(`Failed to load script: ${pluginUrl}`))
        document.head.appendChild(s)
      })

      // Plugin IIFE should have registered its class on window.__tpl.pluginClasses
      const registry = (window as any).__tpl?.pluginClasses
      const PluginClass = registry?.[id]

      if (!PluginClass || typeof PluginClass !== 'function') {
        throw new Error(
          `Plugin ${id} script loaded but class not registered. ` +
          `Expected window.__tpl.pluginClasses["${id}"] to be set.`
        )
      }

      const instance: Plugin = new PluginClass()
      instance._init(entry.manifest, this.appRef, {})

      await instance.settings.load()
      await instance.onload()

      entry.instance = instance
      entry.loaded = true
      this.events.emit('plugin:loaded', id)
      console.log(TAG, `plugin loaded: ${id}`)
    } catch (err) {
      console.error(TAG, `failed to load plugin ${id}:`, err)
    } finally {
      entry.loading = false
    }
  }

  /** Unload a specific plugin. */
  unloadPlugin(id: string): void {
    const entry = this.plugins.get(id)
    if (!entry?.instance) return

    entry.instance._destroy()
    entry.instance = null
    entry.loaded = false
    this.events.emit('plugin:unloaded', id)
    console.log(`[tpl] plugin unloaded: ${id}`)
  }

  /** Get a loaded plugin instance. */
  getPlugin(id: string): Plugin | null {
    return this.plugins.get(id)?.instance ?? null
  }

  /** Get all registered plugin manifests. */
  getManifests(): PluginManifest[] {
    return [...this.plugins.values()].map(e => e.manifest)
  }

  /** Check if a plugin is loaded. */
  isLoaded(id: string): boolean {
    return this.plugins.get(id)?.loaded ?? false
  }
}
