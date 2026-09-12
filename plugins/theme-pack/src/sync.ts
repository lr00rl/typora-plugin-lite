import { parseThemePack, type ThemePack, type ThemePackFile } from './pack.js'
import { PACK_MANIFEST, githubRawUrl, type ThemeSource } from './source.js'
import type { HttpClient } from './http.js'

export interface SyncFs {
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  readText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
  copy(src: string, dest: string): Promise<void>
}

export type FileSyncAction = 'written' | 'unchanged' | 'symlink'

export interface FileSyncResult {
  destName: string
  action: FileSyncAction
  etag?: string | null
}

export interface SyncResult {
  pack: ThemePack
  themesDir: string
  files: FileSyncResult[]
}

export interface PackState {
  source: string
  ref: string
  files: Record<string, { etag?: string | null; kind: FileSyncAction }>
  checkedAt: number
}

export interface SyncDeps {
  fs: SyncFs
  http?: HttpClient
  isSymlink: (path: string) => Promise<boolean>
  join: (...parts: string[]) => string
}

export async function syncThemePack(
  source: ThemeSource,
  themesDir: string,
  deps: SyncDeps,
  previous?: PackState | null,
): Promise<SyncResult> {
  await deps.fs.mkdir(themesDir)
  const pack = await loadPack(source, deps)
  const files: FileSyncResult[] = []
  for (const file of pack.files) {
    files.push(await syncFile(source, file, themesDir, deps, previous?.files[file.destName]?.etag))
  }
  return { pack, themesDir, files }
}

export function packUpdated(result: SyncResult): boolean {
  return result.files.some(file => file.action === 'written')
}

export function nextState(sourceLabel: string, ref: string, result: SyncResult): PackState {
  const files: PackState['files'] = {}
  for (const file of result.files) {
    files[file.destName] = { etag: file.etag ?? undefined, kind: file.action }
  }
  return { source: sourceLabel, ref, files, checkedAt: Date.now() }
}

async function loadPack(source: ThemeSource, deps: SyncDeps): Promise<ThemePack> {
  if (source.kind === 'local') {
    const packPath = deps.join(source.dir, PACK_MANIFEST)
    if (!await deps.fs.exists(packPath)) {
      throw new Error(`theme-pack: missing ${PACK_MANIFEST} bootloader in ${source.dir}`)
    }
    return parseThemePack(await deps.fs.readText(packPath))
  }
  if (!deps.http) throw new Error('theme-pack: HTTP client is required for GitHub sources')
  const url = githubRawUrl(source, PACK_MANIFEST)
  const response = await deps.http.getText(url)
  if (response.status === 404) {
    throw new Error(`theme-pack: ${source.owner}/${source.repo} has no ${PACK_MANIFEST} bootloader`)
  }
  if (response.status !== 200) {
    throw new Error(`theme-pack: ${PACK_MANIFEST} HTTP ${response.status}`)
  }
  return parseThemePack(response.body)
}

async function syncFile(
  source: ThemeSource,
  file: ThemePackFile,
  themesDir: string,
  deps: SyncDeps,
  etag?: string | null,
): Promise<FileSyncResult> {
  const dest = deps.join(themesDir, file.destName)
  if (await deps.isSymlink(dest)) {
    return { destName: file.destName, action: 'symlink', etag: etag ?? null }
  }

  if (source.kind === 'local') {
    const src = deps.join(source.dir, file.path)
    if (!await deps.fs.exists(src)) {
      throw new Error(`theme-pack: missing ${src}`)
    }
    const incoming = await deps.fs.readText(src)
    if (await deps.fs.exists(dest)) {
      const current = await deps.fs.readText(dest)
      if (current === incoming) {
        return { destName: file.destName, action: 'unchanged', etag: null }
      }
    }
    await deps.fs.writeText(dest, incoming)
    return { destName: file.destName, action: 'written', etag: null }
  }

  if (!deps.http) throw new Error('theme-pack: HTTP client is required')
  const result = await deps.http.download(githubRawUrl(source, file.path), dest, etag)
  if (result.status === 304) {
    return { destName: file.destName, action: 'unchanged', etag: result.etag ?? etag ?? null }
  }
  if (result.status === 200) {
    return { destName: file.destName, action: 'written', etag: result.etag }
  }
  throw new Error(`theme-pack: ${file.path} HTTP ${result.status}`)
}
