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
    const pluginsDir = this.platform.pluginsDir
    console.log('[tpl:manager]', 'scan:start', { pluginsDir })
    let dirs: string[]
    try {
      dirs = await this.platform.fs.list(pluginsDir)
      console.log('[tpl:manager]', 'scan:dirs', { count: dirs.length, dirs })
    } catch {
      console.warn('[tpl] plugins directory not found, skipping scan')
      return
    }

    // Read all manifests
    for (const dir of dirs) {
      try {
        const manifestPath = this.platform.path.join(pluginsDir, dir, 'manifest.json')
        const exists = await this.platform.fs.exists(manifestPath)
        console.log('[tpl:manager]', 'scan:manifest-check', { dir, manifestPath, exists })
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
    console.log('[tpl:manager]', 'scan:startup-plugins', { ids: startupPlugins.map(([id]) => id) })
    await Promise.all(startupPlugins.map(([id]) => this.loadPlugin(id)))
  }

  /** Register a plugin manifest and set up lazy loading triggers. */
  private registerPlugin(manifest: PluginManifest): void {
    // Validate required fields
    if (!manifest.id || !manifest.name || !manifest.version || !manifest.loading) {
      console.error(`[tpl] invalid manifest: missing required fields (id, name, version, loading)`, manifest)
      return
    }
    // Reject duplicate IDs
    if (this.plugins.has(manifest.id)) {
      console.error(`[tpl] duplicate plugin id "${manifest.id}", skipping`)
      return
    }

    const entry: PluginEntry = { manifest, instance: null, loaded: false, loading: false }
    this.plugins.set(manifest.id, entry)
    const { loading } = manifest
    console.log('[tpl:manager]', 'register', {
      id: manifest.id,
      name: manifest.name,
      startup: !!loading.startup,
      hotkey: loading.hotkey ?? [],
      event: loading.event ?? [],
    })

    // Event-based lazy loading
    if (loading.event?.length) {
      for (const event of loading.event) {
        console.log('[tpl:manager]', 'register:event-trigger', { id: manifest.id, event })
        const lazyHandler = (...args: unknown[]) => {
          console.log('[tpl:manager]', 'event-triggered', { id: manifest.id, event, args })
          this.loadPlugin(manifest.id).then((loaded) => {
            if (!loaded) return
            this.events.off(event, lazyHandler)
            // Replay the triggering event after load
            this.events.emit(event, ...args)
          })
        }
        this.events.on(event, lazyHandler)
      }
    }

    // Hotkey-based lazy loading
    if (loading.hotkey?.length) {
      for (const key of loading.hotkey) {
        console.log('[tpl:manager]', 'register:hotkey-trigger', { id: manifest.id, key })
        const lazyHandler = () => {
          console.log('[tpl:manager]', 'hotkey-triggered', { id: manifest.id, key })
          this.loadPlugin(manifest.id).then((loaded) => {
            if (!loaded) return
            // Plugin's onload() already called registerHotkey() which overwrote
            // this lazy handler in the bindings Map.  Just trigger the new handler.
            this.hotkeys.trigger(key)
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
  async loadPlugin(id: string): Promise<boolean> {
    const entry = this.plugins.get(id)
    if (!entry) {
      console.warn('[tpl:manager]', 'loadPlugin:missing-entry', { id })
      return false
    }
    if (entry.loaded) {
      console.log('[tpl:manager]', 'loadPlugin:already-loaded', { id })
      return true
    }
    if (entry.loading) {
      console.log('[tpl:manager]', 'loadPlugin:already-loading', { id })
      return false
    }

    entry.loading = true
    const TAG = '[tpl:manager]'
    const mainFile = entry.manifest.main ?? 'main.js'

    // Use baseUrl (the file:// URL set by loader) for script tag src
    // This is a relative-to-HTML URL that WKWebView trusts
    const pluginUrl = `${this.platform.baseUrl}/plugins/${id}/${mainFile}`

    try {
      console.log(TAG, 'load:start', {
        id,
        pluginUrl,
        manifest: entry.manifest,
      })

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
      console.log(TAG, 'load:registry-check', {
        id,
        registryKeys: registry ? Object.keys(registry) : [],
        pluginClassType: typeof PluginClass,
      })

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
      console.log(TAG, 'load:done', { id })
      return true
    } catch (err) {
      console.error(TAG, `failed to load plugin ${id}:`, err)
      return false
    } finally {
      entry.loading = false
    }
  }

  /** Unload a specific plugin. */
  unloadPlugin(id: string): void {
    const entry = this.plugins.get(id)
    if (!entry?.instance) {
      console.log('[tpl:manager]', 'unloadPlugin:skip-no-instance', { id })
      return
    }

    entry.instance._destroy()
    entry.instance = null
    entry.loaded = false
    this.events.emit('plugin:unloaded', id)
    console.log('[tpl:manager]', 'unload:done', { id })
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

  /** Enable (load) a plugin by id. */
  async enablePlugin(id: string): Promise<void> {
    console.log('[tpl:manager]', 'enablePlugin', { id })
    await this.loadPlugin(id)
  }

  /** Disable (unload) a plugin by id. */
  disablePlugin(id: string): void {
    console.log('[tpl:manager]', 'disablePlugin', { id })
    this.unloadPlugin(id)
  }
}
