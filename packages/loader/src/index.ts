/**
 * tpl loader — IIFE, injected into Typora's HTML via <script> tag.
 *
 * Lives at TypeMark/tpl/loader.js (inside Typora's app bundle).
 * Loads core.js from the same directory via <script> tag injection.
 * WKWebView only allows file:// scripts from within the app bundle.
 */
;(function () {
  const TAG = '[tpl:loader]'

  console.log(TAG, 'executing')
  console.log(TAG, 'readyState:', document.readyState)

  // Derive base path: this script is at ./tpl/loader.js relative to index.html
  // We need the path for core.js (same dir) and plugins (./tpl/plugins/...)
  const scripts = document.querySelectorAll('script[src*="tpl/loader.js"]')
  const self = scripts[scripts.length - 1] as HTMLScriptElement
  if (!self?.src) {
    console.error(TAG, 'cannot find own <script> tag')
    return
  }

  const base = self.src.replace(/\/loader\.js(\?.*)?$/, '')
  console.log(TAG, 'base:', base)

  function loadScript(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = url
      s.onload = () => {
        console.log(TAG, 'script loaded:', url)
        resolve()
      }
      s.onerror = (e) => {
        console.error(TAG, 'script failed:', url, e)
        reject(new Error(`Failed to load ${url}`))
      }
      document.head.appendChild(s)
    })
  }

  function boot() {
    console.log(TAG, 'booting...')

    // Store base path so core can find plugins
    ;(window as any).__tpl = (window as any).__tpl || {}
    ;(window as any).__tpl.baseUrl = base

    loadScript(`${base}/core.js`)
      .then(() => {
        const tpl = (window as any).__tpl
        if (!tpl?.bootstrap) {
          console.error(TAG, 'core.js loaded but window.__tpl.bootstrap not found')
          return
        }
        return tpl.bootstrap()
      })
      .then(() => console.log(TAG, 'done'))
      .catch((err) => console.error(TAG, 'boot failed:', err))
  }

  if (document.readyState === 'complete') {
    boot()
  } else {
    window.addEventListener('load', boot, { once: true })
  }
})()
