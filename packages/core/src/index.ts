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

export { IS_MAC, IS_NODE, platform, Plugin, PluginManager, PluginSettings, EventBus, editor, HotkeyManager }
export type { PluginManifest, LoadingStrategy }

export interface TplApp {
  platform: typeof platform
  plugins: PluginManager
  events: EventBus
  hotkeys: HotkeyManager
  editor: typeof editor
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
  const plugins = new PluginManager({ platform, events, hotkeys, editor })

  _app = { platform, plugins, events, hotkeys, editor }

  // Scan and load startup plugins
  await plugins.scanAndLoad()

  console.log(TAG, 'ready — loaded plugins:', plugins.getManifests().map(m => m.id))
  return _app
}

// Register on window for IIFE access
// Plugins access core via window.__tpl.core
const coreExports = {
  IS_MAC, IS_NODE, platform, Plugin, PluginManager, PluginSettings,
  EventBus, editor, HotkeyManager, getApp, bootstrap,
}
;(window as any).__tpl = {
  ...((window as any).__tpl || {}),
  bootstrap,
  getApp,
  core: coreExports,
}
