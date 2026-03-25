/**
 * Platform detection.
 *
 * macOS Typora uses WKWebView — `window.bridge` exists, `window.reqnode` doesn't.
 * Win/Linux Typora uses Electron — `window.reqnode` exists, `window.bridge` doesn't.
 */

export const IS_MAC = typeof window !== 'undefined' && !!window.bridge
export const IS_NODE = !IS_MAC

export function getMountFolder(): string {
  if (IS_NODE) {
    return (window as any).File?.editor?.library?.watchedFolder
      ?? (window as any)._options?.userPath
      ?? ''
  }
  const filePath = (window as any).File?.bundle?.filePath ?? ''
  const idx = filePath.lastIndexOf('/')
  return idx > 0 ? filePath.substring(0, idx) : ''
}

/**
 * Get the base URL where tpl files live (TypeMark/tpl/).
 * Set by loader.js before bootstrapping core.
 * This is a file:// URL used for loading plugin scripts via <script> tags.
 */
export function getBaseUrl(): string {
  return (window as any).__tpl?.baseUrl ?? ''
}

/**
 * Get the filesystem path to the built-in plugins directory (shipped with installer).
 * On macOS: derived from baseUrl → /path/to/tpl/plugins.
 * On Win/Linux: derived from __dirname (window.html location) → tpl/plugins.
 */
export function getBuiltinPluginsDir(): string {
  if (IS_MAC) {
    const baseUrl = getBaseUrl()
    if (baseUrl) {
      const tplDir = decodeURIComponent(baseUrl.replace(/^file:\/\//, ''))
      return `${tplDir}/plugins`
    }
    return ''
  }
  // Electron: use process.resourcesPath to get the actual resources directory
  // (__dirname points into electron.asar which is not a real filesystem path)
  const resourcesPath = (window as any).process?.resourcesPath ?? ''
  if (resourcesPath) {
    const path = window.reqnode?.('path') as typeof import('node:path') | undefined
    return path ? path.join(resourcesPath, 'tpl', 'plugins') : `${resourcesPath}/tpl/plugins`
  }
  return ''
}

/**
 * Get the filesystem path to the user plugins directory (third-party plugins).
 * On macOS: derived from baseUrl → /path/to/tpl/plugins (same as builtin for now).
 * On Win/Linux: use _options.userPath + /plugins.
 * Both platforms return the directory that contains plugin subdirectories.
 */
export function getPluginsDir(): string {
  if (IS_MAC) {
    return getBuiltinPluginsDir()
  }
  const userPath = (window as any)._options?.userPath ?? ''
  return userPath ? `${userPath}/plugins` : ''
}

/**
 * Get the user data directory (survives Typora updates).
 * Settings, caches, indices go here.
 */
export function getDataDir(): string {
  const userPath = (window as any)._options?.userPath ?? ''
  if (IS_MAC) {
    const home = getHomedir()
    if (userPath && home && userPath !== home) {
      return `${userPath}/plugins/data`
    }
    if (home) {
      return `${home}/Library/Application Support/abnerworks.Typora/plugins/data`
    }
    if (userPath) {
      return `${userPath}/plugins/data`
    }
    return '/tmp/Library/Application Support/abnerworks.Typora/plugins/data'
  }
  return userPath ? `${userPath}/plugins/data` : ''
}

export function getHomedir(): string {
  if (IS_NODE) {
    const os = window.reqnode?.('os') as any
    return os?.homedir?.() ?? ''
  }
  const candidates = [
    (window as any).File?.getMountFolder?.(),
    (window as any).File?.bundle?.filePath,
    (window as any).File?.filePath,
    (window as any).File?.editor?.library?.watchedFolder,
    (window as any)._options?.mountFolder,
    (window as any)._options?.userPath,
  ].filter((value): value is string => typeof value === 'string' && !!value)

  for (const candidate of candidates) {
    const match = candidate.match(/^(\/Users\/[^/]+)/)
    if (match) return match[1]
  }
  // macOS: derive from baseUrl path
  const baseUrl = getBaseUrl()
  const match = baseUrl.match(/^file:\/\/(\/Users\/[^/]+)\//)
  if (match) return match[1]
  // Fallback: try NSHomeDirectory pattern from document location
  const docMatch = document.location?.href?.match(/^file:\/\/(\/Users\/[^/]+)\//)
  return docMatch?.[1] ?? '/tmp'
}
