/**
 * Cross-platform filesystem interface.
 */

export interface FileStats {
  isDirectory(): boolean
  isFile(): boolean
  mtimeMs?: number
}

export interface WalkOptions {
  /** File extensions to include (e.g. ['.md', '.markdown']). Empty = all files. */
  exts?: string[]
  /** Directory names to skip (e.g. ['.git', 'node_modules']). */
  ignore?: string[]
  /** Max recursion depth. 0 = root only. Default: 20. */
  maxDepth?: number
  /** Max number of files to return. Default: 5000. */
  maxFiles?: number
}

export interface IFileSystem {
  exists(filepath: string): Promise<boolean>
  stat(filepath: string): Promise<FileStats>
  isDirectory(filepath: string): Promise<boolean>
  mkdir(dirpath: string): Promise<void>
  list(dirpath: string): Promise<string[]>
  /** Recursively walk a directory, returning absolute paths of matching files. */
  walkDir(dirpath: string, opts?: WalkOptions): Promise<string[]>
  readText(filepath: string): Promise<string>
  readTextSync(filepath: string): string
  writeText(filepath: string, text: string): Promise<void>
  appendText(filepath: string, text: string): Promise<void>
  remove(filepath: string): Promise<void>
  copy(src: string, dest: string): Promise<void>
}
