/**
 * macOS filesystem implementation.
 * Uses bridge.callSync for reads, Shell.run for writes/stat/mkdir/list/remove.
 */

import type { IFileSystem, FileStats, WalkOptions } from './filesystem.js'
import { shell } from './shell.js'
const TAG = '[tpl:fs:darwin]'
let rgBinaryPromise: Promise<string | null> | null = null

async function getRgBinary(): Promise<string | null> {
  if (!rgBinaryPromise) {
    rgBinaryPromise = (async () => {
      try {
        const out = (await shell.run('command -v rg || which rg || true', { timeout: 3000 })).trim()
        if (out) {
          console.log(TAG, 'rg:detected', { binary: out, source: 'PATH' })
          return out
        }
      } catch (err) {
        console.warn(TAG, 'rg:path-detect-failed', err)
      }

      const candidates = [
        '/opt/homebrew/bin/rg',
        '/usr/local/bin/rg',
        '/opt/local/bin/rg',
      ]
      for (const candidate of candidates) {
        try {
          await shell.run(`test -x ${shell.escape(candidate)}`, { timeout: 3000 })
          console.log(TAG, 'rg:detected', { binary: candidate, source: 'fallback' })
          return candidate
        } catch {}
      }

      console.log(TAG, 'rg:detected', { binary: null, source: 'none' })
      return null
    })()
  }
  return rgBinaryPromise
}

class DarwinFileStats implements FileStats {
  constructor(private info: string) {}

  isDirectory(): boolean {
    return this.info.includes('FileType: Directory')
  }

  isFile(): boolean {
    return this.info.includes('FileType: Regular File')
  }

  get mtimeMs(): number | undefined {
    const match = this.info.match(/Modify:\s+(.*)/)
    if (!match?.[1]) return undefined
    return new Date(match[1]).getTime()
  }
}

export class DarwinFS implements IFileSystem {
  private async walkDirWithPython(
    dirpath: string,
    exts: string[],
    ignore: string[],
    maxDepth: number,
    maxFiles: number,
  ): Promise<string[]> {
    const script = [
      'import json',
      'import os',
      'import sys',
      '',
      'root = os.path.abspath(sys.argv[1])',
      'exts = {e.lower() for e in json.loads(sys.argv[2])}',
      'ignore = set(json.loads(sys.argv[3]))',
      'max_depth = int(sys.argv[4])',
      'max_files = int(sys.argv[5])',
      'root_depth = root.rstrip(os.sep).count(os.sep)',
      'count = 0',
      '',
      'for current, dirs, files in os.walk(root):',
      '    depth = current.rstrip(os.sep).count(os.sep) - root_depth',
      '    dirs[:] = [d for d in dirs if d not in ignore and not d.startswith(".")]',
      '    if depth >= max_depth:',
      '        dirs[:] = []',
      '    for name in files:',
      '        if name.startswith("."):',
      '            continue',
      '        if exts and os.path.splitext(name)[1].lower() not in exts:',
      '            continue',
      '        print(os.path.join(current, name))',
      '        count += 1',
      '        if count >= max_files:',
      '            sys.exit(0)',
    ].join('\n')

    const cmd = [
      'python3',
      '-',
      shell.escape(dirpath),
      shell.escape(JSON.stringify(exts)),
      shell.escape(JSON.stringify(ignore)),
      shell.escape(String(maxDepth)),
      shell.escape(String(maxFiles)),
      "<<'PY'",
      script,
      'PY',
    ].join('\n')

    console.log(TAG, 'walkDir:python-cmd', cmd)
    const out = await shell.run(cmd, { timeout: 30_000 })
    const results = out.trim().split('\n').filter(Boolean).slice(0, maxFiles)
    console.log(TAG, 'walkDir:python-done', {
      dirpath,
      count: results.length,
      sample: results.slice(0, 20),
    })
    return results
  }

  exists(filepath: string): Promise<boolean> {
    return shell.run(`test -e ${shell.escape(filepath)}`)
      .then(() => true)
      .catch(() => false)
  }

  stat(filepath: string): Promise<FileStats> {
    // BSD stat needs -f format to produce parseable output;
    // default BSD stat output doesn't contain "FileType:" strings.
    return shell.run(`stat -f 'FileType: %HT%nModify: %Sm' -t '%Y-%m-%d %H:%M:%S' ${shell.escape(filepath)}`)
      .then(out => new DarwinFileStats(out))
  }

  isDirectory(filepath: string): Promise<boolean> {
    return shell.run(`test -d ${shell.escape(filepath)}`)
      .then(() => true)
      .catch(() => false)
  }

  mkdir(dirpath: string): Promise<void> {
    return shell.run(`mkdir -p ${shell.escape(dirpath)}`) as Promise<any>
  }

  list(dirpath: string): Promise<string[]> {
    return shell.run(`ls ${shell.escape(dirpath)}`)
      .then(out => out.trim().split('\n').filter(Boolean))
  }

  async walkDir(dirpath: string, opts: WalkOptions = {}): Promise<string[]> {
    const exts = opts.exts ?? []
    const ignore = opts.ignore ?? ['.git', 'node_modules', '.obsidian', '.trash']
    const maxDepth = opts.maxDepth ?? 20
    const maxFiles = opts.maxFiles ?? 5000
    console.log(TAG, 'walkDir:start', { dirpath, exts, ignore, maxDepth, maxFiles })

    const rgBinary = await getRgBinary()
    if (rgBinary) {
      const rgParts = [shell.escape(rgBinary), '--files']
      for (const ext of exts) {
        rgParts.push('-g', shell.escape(`*${ext}`))
      }
      for (const name of ignore) {
        rgParts.push('-g', shell.escape(`!**/${name}/**`))
      }
      rgParts.push('.')
      const rgCmd = rgParts.join(' ')
      try {
        console.log(TAG, 'walkDir:rg-cmd', rgCmd)
        const out = await shell.run(rgCmd, { cwd: dirpath, timeout: 30_000 })
        const results = out.trim().split('\n').filter(Boolean).slice(0, maxFiles)
        console.log(TAG, 'walkDir:rg-done', {
          dirpath,
          count: results.length,
          sample: results.slice(0, 20),
        })
        return results
      } catch (err) {
        console.error(TAG, 'walkDir:rg-failed', { dirpath, err })
      }
    }

    try {
      return await this.walkDirWithPython(dirpath, exts, ignore, maxDepth, maxFiles)
    } catch (err) {
      console.error(TAG, 'walkDir:python-failed', { dirpath, err })
    }

    // Build a `find` command — much faster than recursive shell.run('ls')
    const parts = ['find', shell.escape(dirpath)]
    // Max depth
    parts.push(`-maxdepth ${maxDepth}`)
    // Prune ignored directories
    if (ignore.length) {
      const pruneExpr = ignore.map(d => `-name ${shell.escape(d)}`).join(' -o ')
      parts.push(`\\( -type d \\( ${pruneExpr} \\) -prune \\)`)
      parts.push('-o')
    }
    // Match files
    parts.push('-type f')
    // Filter by extension
    if (exts.length) {
      const extExpr = exts.map(e => `-name ${shell.escape('*' + e)}`).join(' -o ')
      parts.push(`\\( ${extExpr} \\)`)
    }
    parts.push('-print')
    // Limit output
    parts.push(`| head -n ${maxFiles}`)

    const cmd = parts.join(' ')
    try {
      console.log(TAG, 'walkDir:cmd', cmd)
      const out = await shell.run(cmd, { timeout: 60_000 })
      const results = out.trim().split('\n').filter(Boolean)
      console.log(TAG, 'walkDir:done', {
        dirpath,
        count: results.length,
        sample: results.slice(0, 20),
      })
      return results
    } catch (err) {
      console.error(TAG, 'walkDir:failed', { dirpath, err })
      throw err
    }
  }

  readText(filepath: string): Promise<string> {
    return Promise.resolve(this.readTextSync(filepath))
  }

  readTextSync(filepath: string): string {
    return window.bridge!.callSync('path.readText', filepath)
  }

  writeText(filepath: string, text: string): Promise<void> {
    return shell.run(`printf '%s' ${shell.escape(text)} > ${shell.escape(filepath)}`) as Promise<any>
  }

  appendText(filepath: string, text: string): Promise<void> {
    return shell.run(`printf '%s' ${shell.escape(text)} >> ${shell.escape(filepath)}`) as Promise<any>
  }

  remove(filepath: string): Promise<void> {
    return shell.run(`rm -rf ${shell.escape(filepath)}`) as Promise<any>
  }

  copy(src: string, dest: string): Promise<void> {
    return shell.run(`cp -r ${shell.escape(src)} ${shell.escape(dest)}`) as Promise<any>
  }
}
