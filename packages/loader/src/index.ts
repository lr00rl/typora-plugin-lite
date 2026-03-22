/**
 * tpl loader — IIFE, injected into Typora's HTML via <script> tag.
 *
 * WKWebView (macOS) does NOT support file:// ESM import().
 * So we load core.js by injecting a <script> tag, and core registers itself
 * on window.__tpl. Plugins are loaded the same way (script tag injection).
 */
;(function () {
  const TAG = '[tpl:loader]'

  console.log(TAG, 'loader executing')
  console.log(TAG, 'readyState:', document.readyState)
  console.log(TAG, 'userAgent:', navigator.userAgent)

  // Derive base path from this script's src attribute
  const scripts = document.querySelectorAll('script[src*="loader.js"]')
  const self = scripts[scripts.length - 1] as HTMLScriptElement
  if (!self?.src) {
    console.error(TAG, 'cannot find own <script> tag')
    return
  }

  const base = self.src.replace(/\/loader\.js(\?.*)?$/, '')
  console.log(TAG, 'base path:', base)

  function loadScript(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = url
      s.onload = () => {
        console.log(TAG, 'loaded:', url)
        resolve()
      }
      s.onerror = (e) => {
        console.error(TAG, 'failed to load:', url, e)
        reject(new Error(`Failed to load ${url}`))
      }
      document.head.appendChild(s)
    })
  }

  function boot() {
    console.log(TAG, 'booting...')
    loadScript(`${base}/core.js`)
      .then(() => {
        const tpl = (window as any).__tpl
        if (!tpl?.bootstrap) {
          console.error(TAG, 'core.js loaded but window.__tpl.bootstrap not found')
          return
        }
        return tpl.bootstrap()
      })
      .then(() => console.log(TAG, 'bootstrap complete'))
      .catch((err) => console.error(TAG, 'boot failed:', err))
  }

  if (document.readyState === 'complete') {
    boot()
  } else {
    window.addEventListener('load', boot, { once: true })
  }
})()
