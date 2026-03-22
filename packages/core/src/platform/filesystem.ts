/**
 * Cross-platform filesystem interface.
 */

export interface FileStats {
  isDirectory(): boolean
  isFile(): boolean
  mtimeMs?: number
}

export interface IFileSystem {
  exists(filepath: string): Promise<boolean>
  stat(filepath: string): Promise<FileStats>
  isDirectory(filepath: string): Promise<boolean>
  mkdir(dirpath: string): Promise<void>
  list(dirpath: string): Promise<string[]>
  readText(filepath: string): Promise<string>
  readTextSync(filepath: string): string
  writeText(filepath: string, text: string): Promise<void>
  appendText(filepath: string, text: string): Promise<void>
  remove(filepath: string): Promise<void>
  copy(src: string, dest: string): Promise<void>
}
