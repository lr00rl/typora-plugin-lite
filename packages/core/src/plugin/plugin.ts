/**
 * Plugin base class.
 * All register* methods push to disposables[]. unload() auto-cleans everything.
 */

import type { PluginManifest } from './manifest.js'
import type { EventBus } from './events.js'
import { PluginSettings } from './settings.js'
import type { Platform } from '../platform/index.js'
import type { HotkeyManager } from '../hotkey/manager.js'

let noticeToastEl: HTMLDivElement | null = null
let noticeHideTimer = 0
let noticeRemoveTimer = 0

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
    // Direct DOM toast as fallback (until UI runtime is built in Phase 2).
    // Reuse a single element so rapid consecutive notices do not visually overlap.
    const toast = noticeToastEl ?? document.createElement('div')
    noticeToastEl = toast
    toast.textContent = msg
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 20px',
      background: 'rgba(0,0,0,0.75)',
      color: '#fff',
      borderRadius: '6px',
      fontSize: '13px',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      zIndex: '99999',
      transition: 'opacity 0.3s',
      opacity: '0',
      pointerEvents: 'none',
    })
    if (!toast.isConnected) {
      document.body.appendChild(toast)
    }

    window.clearTimeout(noticeHideTimer)
    window.clearTimeout(noticeRemoveTimer)
    toast.style.opacity = '0'
    requestAnimationFrame(() => { toast.style.opacity = '1' })
    noticeHideTimer = window.setTimeout(() => {
      toast.style.opacity = '0'
      noticeRemoveTimer = window.setTimeout(() => {
        toast.remove()
        if (noticeToastEl === toast) {
          noticeToastEl = null
        }
      }, 300)
    }, duration)
  }
}
