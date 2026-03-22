/**
 * Win/Linux (Electron) filesystem implementation.
 * Uses reqnode('fs') for all operations.
 */

import type { IFileSystem, FileStats } from './filesystem.js'

export class NodeFS implements IFileSystem {
  private get _fs() {
    return window.reqnode!('fs') as typeof import('node:fs')
  }

  private get _fsp() {
    return this._fs.promises
  }

  exists(filepath: string): Promise<boolean> {
    return this._fsp.access(filepath)
      .then(() => true)
      .catch(() => false)
  }

  stat(filepath: string): Promise<FileStats> {
    return this._fsp.stat(filepath) as unknown as Promise<FileStats>
  }

  isDirectory(filepath: string): Promise<boolean> {
    return this._fsp.stat(filepath)
      .then(s => s.isDirectory())
      .catch(() => false)
  }

  mkdir(dirpath: string): Promise<void> {
    return this._fsp.mkdir(dirpath, { recursive: true }).then(() => {})
  }

  list(dirpath: string): Promise<string[]> {
    return this._fsp.readdir(dirpath)
  }

  readText(filepath: string): Promise<string> {
    return this._fsp.readFile(filepath, 'utf8')
  }

  readTextSync(filepath: string): string {
    return this._fs.readFileSync(filepath, 'utf8')
  }

  writeText(filepath: string, text: string): Promise<void> {
    return this._fsp.writeFile(filepath, text, 'utf8')
  }

  appendText(filepath: string, text: string): Promise<void> {
    return this._fsp.appendFile(filepath, text, 'utf8')
  }

  remove(filepath: string): Promise<void> {
    return this._fsp.rm(filepath, { recursive: true })
  }

  copy(src: string, dest: string): Promise<void> {
    return this._fsp.cp(src, dest, { recursive: true })
  }
}
