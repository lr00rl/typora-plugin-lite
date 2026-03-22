/**
 * Plugin base class.
 * All register* methods push to disposables[]. unload() auto-cleans everything.
 */

import type { PluginManifest } from './manifest.js'
import type { EventBus } from './events.js'
import { PluginSettings } from './settings.js'
import type { Platform } from '../platform/index.js'
import type { HotkeyManager } from '../hotkey/manager.js'

export interface Command {
  id: string
  name: string
  callback: () => void | Promise<void>
}

export interface TplAppRef {
  platform: Platform
  events: EventBus
  hotkeys: HotkeyManager
}

export abstract class Plugin<T extends Record<string, unknown> = Record<string, unknown>> {
  manifest!: PluginManifest
  app!: TplAppRef
  settings!: PluginSettings<T>

  private disposables: Array<() => void> = []

  /** Called when the plugin is loaded. Override this. */
  abstract onload(): void | Promise<void>

  /** Called when the plugin is unloaded. Override for custom cleanup. */
  onunload(): void {}

  /** @internal Initialize plugin internals. Called by PluginManager. */
  _init(manifest: PluginManifest, app: TplAppRef, defaults: T): void {
    this.manifest = manifest
    this.app = app
    this.settings = new PluginSettings<T>(manifest.id, defaults, app.platform)
  }

  /** @internal Tear down all registered resources. */
  _destroy(): void {
    try {
      this.onunload()
    } catch (err) {
      console.error(`[tpl] ${this.manifest.id} onunload error:`, err)
    }
    for (const dispose of this.disposables) {
      try { dispose() } catch {}
    }
    this.disposables.length = 0
  }

  // --- Registration helpers (all auto-disposed on unload) ---

  registerCommand(cmd: Command): void {
    this.app.events.emit('command:register', cmd)
    this.disposables.push(() => this.app.events.emit('command:unregister', cmd.id))
  }

  registerHotkey(key: string, callback: () => void): void {
    this.app.hotkeys.register(key, callback)
    this.disposables.push(() => this.app.hotkeys.unregister(key))
  }

  registerEvent(event: string, handler: (...args: any[]) => void): void {
    this.app.events.on(event, handler)
    this.disposables.push(() => this.app.events.off(event, handler))
  }

  registerDomEvent(el: EventTarget, event: string, handler: EventListener, options?: AddEventListenerOptions): void {
    el.addEventListener(event, handler, options)
    this.disposables.push(() => el.removeEventListener(event, handler, options))
  }

  registerInterval(callback: () => void, ms: number): void {
    const id = window.setInterval(callback, ms)
    this.disposables.push(() => clearInterval(id))
  }

  registerCss(css: string): void {
    const style = document.createElement('style')
    style.dataset.tplPlugin = this.manifest.id
    style.textContent = css
    document.head.appendChild(style)
    this.disposables.push(() => style.remove())
  }

  addDisposable(dispose: () => void): void {
    this.disposables.push(dispose)
  }

  showNotice(msg: string, duration = 3000): void {
    this.app.events.emit('ui:notice', { msg, duration, pluginId: this.manifest.id })
  }
}
