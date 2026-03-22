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
 * Get the filesystem path to the tpl directory.
 * On macOS: derived from baseUrl (strip file:// prefix, decode %20).
 * On Win/Linux: use _options.userPath + /plugins.
 */
export function getPluginsDir(): string {
  if (IS_MAC) {
    const baseUrl = getBaseUrl()
    if (baseUrl) {
      // Convert file:///path/to/tpl → /path/to/tpl
      return decodeURIComponent(baseUrl.replace(/^file:\/\//, ''))
    }
    return ''
  }
  const userPath = (window as any)._options?.userPath ?? ''
  return userPath ? `${userPath}/plugins` : ''
}

/**
 * Get the user data directory (survives Typora updates).
 * Settings, caches, indices go here.
 */
export function getDataDir(): string {
  if (IS_MAC) {
    const home = getHomedir()
    return `${home}/Library/Application Support/abnerworks.Typora/plugins/data`
  }
  const userPath = (window as any)._options?.userPath ?? ''
  return userPath ? `${userPath}/plugins/data` : ''
}

export function getHomedir(): string {
  if (IS_NODE) {
    const os = window.reqnode?.('os') as any
    return os?.homedir?.() ?? ''
  }
  // macOS: derive from baseUrl path
  const baseUrl = getBaseUrl()
  const match = baseUrl.match(/^file:\/\/(\/Users\/[^/]+)\//)
  if (match) return match[1]
  // Fallback: try NSHomeDirectory pattern from document location
  const docMatch = document.location?.href?.match(/^file:\/\/(\/Users\/[^/]+)\//)
  return docMatch?.[1] ?? '/tmp'
}
