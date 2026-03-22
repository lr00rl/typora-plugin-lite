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
    // Electron: File.editor?.library?.watchedFolder or _options.userPath
    return (window as any).File?.editor?.library?.watchedFolder
      ?? (window as any)._options?.userPath
      ?? ''
  }
  // macOS: derive from current file path
  const filePath = (window as any).File?.bundle?.filePath ?? ''
  const idx = filePath.lastIndexOf('/')
  return idx > 0 ? filePath.substring(0, idx) : ''
}

export function getPluginsDir(): string {
  if (IS_MAC) {
    return `${getHomedir()}/Library/Application Support/abnerworks.Typora/plugins`
  }
  // Win/Linux: use _options.userPath or typical appdata location
  const userPath = (window as any)._options?.userPath ?? ''
  return userPath ? `${userPath}/plugins` : ''
}

export function getHomedir(): string {
  if (IS_NODE) {
    const os = window.reqnode?.('os') as any
    return os?.homedir?.() ?? ''
  }
  // macOS: derive from NSHomeDirectory via shell, but for sync we use a heuristic
  // bridge.callSync doesn't support os-level calls, so use /Users/<user> pattern
  // The plugins dir is always under ~/Library/..., we can get ~ from the script src
  const scripts = document.querySelectorAll('script[src*="loader.js"]')
  const src = (scripts[scripts.length - 1] as HTMLScriptElement)?.src ?? ''
  const match = src.match(/^file:\/\/(\/Users\/[^/]+)\//)
  return match?.[1] ?? '/tmp'
}
