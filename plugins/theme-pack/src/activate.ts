export function isDarkMode(doc: Document = document): boolean {
  const cl = doc.body?.classList
  if (!cl) return false
  return cl.contains('os-dark') || cl.contains('dark-mode') || cl.contains('night')
}

export function themeStylesheetLink(doc: Document): HTMLLinkElement | null {
  const byId = doc.getElementById('theme_css') ?? doc.getElementById('theme')
  if (isStylesheetLink(byId)) return byId
  const sheets = [...doc.querySelectorAll('link[rel="stylesheet"]')].filter(isStylesheetLink)
  return sheets.find(link => /\/themes[\\/]/i.test(link.getAttribute('href') || link.href) && /\.css(\?|$)/i.test(link.getAttribute('href') || link.href))
    ?? null
}

export function hrefBaseName(href: string): string {
  const cleaned = (href.split('#')[0] ?? href).replace(/[?&]tpl=\d+/g, '')
  try {
    const path = new URL(cleaned, 'file:///').pathname
    const last = path.replace(/\\/g, '/').split('/').pop() ?? ''
    return decodeURIComponent(last).toLowerCase()
  } catch {
    return cleaned.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  }
}

/**
 * If Typora is already showing one of the pack files, cache-bust that same
 * stylesheet so an updated CSS is picked up. Never retarget a built-in theme.
 */
export function reloadManagedThemeIfActive(
  doc: Document,
  destNames: Iterable<string>,
): boolean {
  const link = themeStylesheetLink(doc)
  if (!link) return false
  const href = link.getAttribute('href') || link.href
  const name = hrefBaseName(href)
  const managed = new Set([...destNames].map(item => item.toLowerCase()))
  if (!name || !managed.has(name)) return false
  const stripped = stripTpl(href)
  link.setAttribute('href', stampUrl(stripped))
  return true
}

export function refreshTyporaThemeCatalog(host: {
  JSBridge?: { invoke?: (name: string, ...args: unknown[]) => unknown }
  bridge?: { callHandler?: (name: string, payload?: unknown) => void }
}): void {
  try { host.JSBridge?.invoke?.('menu.refreshThemeMenu') } catch {}
  try { host.bridge?.callHandler?.('menu.updateMenu') } catch {}
}

function isStylesheetLink(node: Element | null): node is HTMLLinkElement {
  return !!node && node.tagName.toUpperCase() === 'LINK' && 'href' in node
}

function stripTpl(href: string): string {
  const [withoutHash, hash] = href.split('#')
  const next = (withoutHash ?? href)
    .replace(/[?&]tpl=\d+/g, '')
    .replace(/\?&/, '?')
    .replace(/\?$/, '')
    .replace(/&$/, '')
  return hash ? `${next}#${hash}` : next
}

function stampUrl(fileUrl: string): string {
  const url = fileUrl.split('#')[0] ?? fileUrl
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}tpl=${Date.now()}`
}
