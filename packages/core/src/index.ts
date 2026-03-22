// Core entry point — wires together all subsystems

export { IS_MAC, IS_NODE, platform } from './platform/index.js'
export { Plugin } from './plugin/plugin.js'
export type { PluginManifest, LoadingStrategy } from './plugin/manifest.js'
export { PluginManager } from './plugin/manager.js'
export { PluginSettings } from './plugin/settings.js'
export { EventBus } from './plugin/events.js'
export { editor } from './editor/api.js'
export { HotkeyManager } from './hotkey/manager.js'

import { platform } from './platform/index.js'
import { PluginManager } from './plugin/manager.js'
import { EventBus } from './plugin/events.js'
import { HotkeyManager } from './hotkey/manager.js'
import { editor } from './editor/api.js'

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

  console.log('[tpl] bootstrapping core...')

  const events = new EventBus()
  const hotkeys = new HotkeyManager()
  const plugins = new PluginManager({ platform, events, hotkeys, editor })

  _app = { platform, plugins, events, hotkeys, editor }

  // Scan and load startup plugins
  await plugins.scanAndLoad()

  console.log('[tpl] core ready')
  return _app
}
