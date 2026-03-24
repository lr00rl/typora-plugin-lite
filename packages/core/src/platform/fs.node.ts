/**
 * Win/Linux (Electron) filesystem implementation.
 * Uses reqnode('fs') for all operations.
 */

import type { IFileSystem, FileStats, WalkOptions } from './filesystem.js'
const TAG = '[tpl:fs:node]'

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

  async walkDir(dirpath: string, opts: WalkOptions = {}): Promise<string[]> {
    const exts = opts.exts?.map(e => e.toLowerCase()) ?? []
    const ignoreSet = new Set(opts.ignore ?? ['.git', 'node_modules', '.obsidian', '.trash'])
    const maxDepth = opts.maxDepth ?? 20
    const maxFiles = opts.maxFiles ?? 5000
    const results: string[] = []
    const path = window.reqnode!('path') as typeof import('node:path')
    console.log(TAG, 'walkDir:start', { dirpath, exts, ignore: [...ignoreSet], maxDepth, maxFiles })

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth || results.length >= maxFiles) return
      let entries: string[]
      try { entries = await this._fsp.readdir(dir) } catch { return }
      for (const name of entries) {
        if (results.length >= maxFiles) return
        if (name.startsWith('.') || ignoreSet.has(name)) continue
        const full = path.join(dir, name)
        let stat: import('node:fs').Stats
        try { stat = await this._fsp.stat(full) } catch { continue }
        if (stat.isDirectory()) {
          await walk(full, depth + 1)
        } else if (stat.isFile()) {
          if (exts.length === 0 || exts.includes(path.extname(name).toLowerCase())) {
            results.push(full)
          }
        }
      }
    }

    await walk(dirpath, 0)
    console.log(TAG, 'walkDir:done', { dirpath, count: results.length, sample: results.slice(0, 20) })
    return results
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
