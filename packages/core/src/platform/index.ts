/**
 * Platform abstraction — unified API for fs, shell, path.
 * Plugins use `platform.fs`, `platform.shell`, `platform.path` — never touch bridge/reqnode directly.
 */

export { IS_MAC, IS_NODE, getPluginsDir, getMountFolder } from './detect.js'
export type { IFileSystem, FileStats } from './filesystem.js'
export type { IShell } from './shell.js'
export type { IPath } from './path.js'

import { IS_MAC, getPluginsDir } from './detect.js'
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
  pluginsDir: string
}

export const platform: Platform = {
  fs: IS_MAC ? new DarwinFS() : new NodeFS(),
  shell,
  path,
  get pluginsDir() { return getPluginsDir() },
}
