// Core entry point — wires together all subsystems
// Registers on window.__tpl for IIFE-based loading (WKWebView doesn't support file:// ESM)

import { IS_MAC, IS_NODE, platform } from './platform/index.js'
import { Plugin } from './plugin/plugin.js'
import type { PluginManifest, LoadingStrategy } from './plugin/manifest.js'
import { PluginManager } from './plugin/manager.js'
import { PluginSettings } from './plugin/settings.js'
import { EventBus } from './plugin/events.js'
import { editor } from './editor/api.js'
import { HotkeyManager } from './hotkey/manager.js'
import { PluginCenterPanel } from './ui/plugin-center.js'
import { CommandRegistry } from './command/registry.js'

export { IS_MAC, IS_NODE, platform, Plugin, PluginManager, PluginSettings, EventBus, editor, HotkeyManager, PluginCenterPanel, CommandRegistry }
export type { PluginManifest, LoadingStrategy }

export interface TplApp {
  platform: typeof platform
  plugins: PluginManager
  events: EventBus
  hotkeys: HotkeyManager
  commands: CommandRegistry
  editor: typeof editor
  pluginCenter: PluginCenterPanel
}

let _app: TplApp | null = null

export function getApp(): TplApp {
  if (!_app) throw new Error('tpl: core not initialized')
  return _app
}

export async function bootstrap(): Promise<TplApp> {
  if (_app) return _app

  const TAG = '[tpl:core]'
  console.log(TAG, 'bootstrapping...')
  console.log(TAG, 'platform:', IS_MAC ? 'macOS (WKWebView)' : 'Win/Linux (Electron)')
  console.log(TAG, 'baseUrl:', platform.baseUrl)
  console.log(TAG, 'pluginsDir:', platform.pluginsDir)
  console.log(TAG, 'dataDir:', platform.dataDir)

  const events = new EventBus()
  const hotkeys = new HotkeyManager()
  const commands = new CommandRegistry(events)
  const plugins = new PluginManager({ platform, events, hotkeys, editor })
  const pluginCenter = new PluginCenterPanel(plugins, hotkeys)

  // Register Mod+` to toggle Plugin Center
  hotkeys.register('Mod+`', () => pluginCenter.toggle())

  _app = { platform, plugins, events, hotkeys, commands, editor, pluginCenter }

  // Scan and load startup plugins
  await plugins.scanAndLoad()

  const loadedIds = plugins.getManifests().filter(m => plugins.isLoaded(m.id)).map(m => m.id)
  console.log(TAG, 'ready — loaded plugins:', loadedIds)

  // Visual feedback: brief toast so user knows tpl loaded
  showLoadedToast(loadedIds.length)

  return _app
}

/** Show a brief visual toast indicating tpl loaded successfully. */
function showLoadedToast(pluginCount: number): void {
  const toast = document.createElement('div')
  toast.textContent = `tpl: ${pluginCount} plugin${pluginCount !== 1 ? 's' : ''} loaded`
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    padding: '8px 16px',
    background: 'rgba(0,0,0,0.7)',
    color: '#fff',
    borderRadius: '6px',
    fontSize: '13px',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    zIndex: '99999',
    transition: 'opacity 0.3s',
    opacity: '0',
    pointerEvents: 'none',
  })
  document.body.appendChild(toast)
  // Fade in
  requestAnimationFrame(() => { toast.style.opacity = '1' })
  // Fade out and remove after 3s
  setTimeout(() => {
    toast.style.opacity = '0'
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}

// Register on window for IIFE access
// Plugins access core via window.__tpl.core
const coreExports = {
  IS_MAC, IS_NODE, platform, Plugin, PluginManager, PluginSettings,
  EventBus, editor, HotkeyManager, CommandRegistry, getApp, bootstrap,
}
;(window as any).__tpl = {
  ...((window as any).__tpl || {}),
  bootstrap,
  getApp,
  core: coreExports,
}
