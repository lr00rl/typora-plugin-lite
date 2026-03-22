/**
 * Cross-platform path utilities.
 * macOS: pure JS reimplementation (~60 lines).
 * Win/Linux: reqnode('path').
 */

import { IS_MAC } from './detect.js'

export interface IPath {
  join(...parts: string[]): string
  dirname(p: string): string
  basename(p: string, ext?: string): string
  extname(p: string): string
  resolve(...parts: string[]): string
  isAbsolute(p: string): boolean
  sep: string
}

class PurePath implements IPath {
  readonly sep = '/'

  join(...parts: string[]): string {
    const joined = parts.filter(Boolean).join('/')
    return this.normalize(joined)
  }

  dirname(p: string): string {
    if (!p) return '.'
    const idx = p.lastIndexOf('/')
    if (idx < 0) return '.'
    if (idx === 0) return '/'
    return p.substring(0, idx)
  }

  basename(p: string, ext?: string): string {
    if (!p) return ''
    // Remove trailing slashes
    let end = p.length
    while (end > 1 && p[end - 1] === '/') end--
    const trimmed = p.substring(0, end)
    const idx = trimmed.lastIndexOf('/')
    const name = idx < 0 ? trimmed : trimmed.substring(idx + 1)
    if (ext && name.endsWith(ext)) {
      return name.substring(0, name.length - ext.length)
    }
    return name
  }

  extname(p: string): string {
    const name = this.basename(p)
    const idx = name.lastIndexOf('.')
    if (idx <= 0) return ''
    return name.substring(idx)
  }

  resolve(...parts: string[]): string {
    let resolved = ''
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      if (!part) continue
      resolved = resolved ? `${part}/${resolved}` : part
      if (part.startsWith('/')) break
    }
    return this.normalize(resolved || '/')
  }

  isAbsolute(p: string): boolean {
    return p.startsWith('/')
  }

  private normalize(p: string): string {
    const isAbs = p.startsWith('/')
    const parts = p.split('/').filter(Boolean)
    const result: string[] = []
    for (const part of parts) {
      if (part === '.') continue
      if (part === '..') {
        if (result.length > 0 && result[result.length - 1] !== '..') {
          result.pop()
        } else if (!isAbs) {
          result.push('..')
        }
      } else {
        result.push(part)
      }
    }
    const normalized = result.join('/')
    return isAbs ? `/${normalized}` : (normalized || '.')
  }
}

class NodePath implements IPath {
  private get _path() {
    return window.reqnode!('path') as typeof import('node:path')
  }

  get sep(): string { return this._path.sep }

  join(...parts: string[]): string { return this._path.join(...parts) }
  dirname(p: string): string { return this._path.dirname(p) }
  basename(p: string, ext?: string): string { return this._path.basename(p, ext) }
  extname(p: string): string { return this._path.extname(p) }
  resolve(...parts: string[]): string { return this._path.resolve(...parts) }
  isAbsolute(p: string): boolean { return this._path.isAbsolute(p) }
}

export const path: IPath = IS_MAC ? new PurePath() : new NodePath()
