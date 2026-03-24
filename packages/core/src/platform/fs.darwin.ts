/**
 * macOS filesystem implementation.
 * Uses bridge.callSync for reads, Shell.run for writes/stat/mkdir/list/remove.
 */

import type { IFileSystem, FileStats } from './filesystem.js'
import { shell } from './shell.js'

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
