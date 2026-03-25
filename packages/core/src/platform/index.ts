/**
 * Platform abstraction — unified API for fs, shell, path.
 * Plugins use `platform.fs`, `platform.shell`, `platform.path` — never touch bridge/reqnode directly.
 */

export { IS_MAC, IS_NODE, getPluginsDir, getBuiltinPluginsDir, getBaseUrl, getDataDir, getMountFolder } from './detect.js'
export type { IFileSystem, FileStats, WalkOptions } from './filesystem.js'
export type { IShell } from './shell.js'
export type { IPath } from './path.js'

import { IS_MAC, getPluginsDir, getBuiltinPluginsDir, getBaseUrl, getDataDir } from './detect.js'
import { DarwinFS } from './fs.darwin.js'
import { NodeFS } from './fs.node.js'
import type { IFileSystem } from './filesystem.js'
import { shell } from './shell.js'
import type { IShell } from './shell.js'
import { path } from './path.js'
import type { IPath } from './path.js'

export interface Platform {
  fs: IFileSystem
  shell: IShell
  path: IPath
  /** Filesystem path to built-in plugins (shipped with installer, inside Typora resources) */
  builtinPluginsDir: string
  /** Filesystem path to user plugins directory (third-party plugins) */
  pluginsDir: string
  /** URL form of tpl directory (for <script> tag injection) */
  baseUrl: string
  /** Filesystem path for persistent data (settings, caches — survives updates) */
  dataDir: string
}

export const platform: Platform = {
  fs: IS_MAC ? new DarwinFS() : new NodeFS(),
  shell,
  path,
  get builtinPluginsDir() { return getBuiltinPluginsDir() },
  get pluginsDir() { return getPluginsDir() },
  get baseUrl() { return getBaseUrl() },
  get dataDir() { return getDataDir() },
}
