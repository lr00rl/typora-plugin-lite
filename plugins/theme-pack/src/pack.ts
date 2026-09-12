export const BOOTLOADER_TYPE = 'typora-plugin-lite-theme-pack'
export const BOOTLOADER_VERSION = 1

export interface ThemePackFile {
  path: string
  destName: string
}

export interface ThemePack {
  name: string
  files: ThemePackFile[]
  light?: string
  dark?: string
}

export function parseThemePack(raw: string): ThemePack {
  let parsed: {
    typ?: unknown
    version?: unknown
    name?: unknown
    files?: unknown
    light?: unknown
    dark?: unknown
  }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    throw new Error('theme-pack.json is not valid JSON')
  }

  if (parsed.typ !== BOOTLOADER_TYPE) {
    throw new Error(`not a typora-plugin-lite theme pack (typ must be "${BOOTLOADER_TYPE}")`)
  }
  if (parsed.version !== BOOTLOADER_VERSION) {
    throw new Error(`unsupported theme-pack version: ${String(parsed.version)}`)
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error('theme-pack.json must list at least one file')
  }

  const files = parsed.files.map((entry, index) => {
    const path = typeof entry === 'string' ? entry : (entry as { path?: unknown })?.path
    if (typeof path !== 'string' || !path.trim()) {
      throw new Error(`theme-pack.json files[${index}] is missing path`)
    }
    return packFile(path)
  })

  const names = new Set(files.map(file => file.destName))
  const light = optionalCssName(parsed.light, names, 'light')
  const dark = optionalCssName(parsed.dark, names, 'dark')
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Theme Pack'
  return { name, files, light, dark }
}

export function packFile(path: string): ThemePackFile {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('..') || normalized.includes(':')) {
    throw new Error(`unsafe theme path: ${path}`)
  }
  if (normalized.includes('/')) {
    throw new Error(`theme-pack files must sit at the repo root: ${path}`)
  }
  if (!normalized.toLowerCase().endsWith('.css')) {
    throw new Error(`theme-pack files must be .css: ${path}`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.css$/i.test(normalized)) {
    throw new Error(`invalid theme filename: ${path}`)
  }
  return { path: normalized, destName: normalized.toLowerCase() }
}

function optionalCssName(value: unknown, names: Set<string>, field: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const destName = packFile(value).destName
  if (!names.has(destName)) {
    throw new Error(`theme-pack.json ${field} is not in files: ${value}`)
  }
  return destName
}
