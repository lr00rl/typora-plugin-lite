/**
 * tpl loader — IIFE, ~30 lines
 * Injected into Typora's HTML via <script> tag.
 * Dynamically imports core.js to bootstrap the plugin system.
 */
;(function () {
  // Derive plugin base path from this script's location
  const scripts = document.querySelectorAll('script[src*="loader.js"]')
  const self = scripts[scripts.length - 1] as HTMLScriptElement
  if (!self?.src) return

  const base = self.src.replace(/\/loader\.js(\?.*)?$/, '')
  const coreUrl = `${base}/core.js`

  function boot() {
    import(/* webpackIgnore: true */ coreUrl)
      .then((mod) => mod.bootstrap())
      .then(() => console.log('[tpl] loaded'))
      .catch((err) => console.error('[tpl] failed to load core:', err))
  }

  // Wait for Typora's editor to be available
  if (document.readyState === 'complete') {
    boot()
  } else {
    window.addEventListener('load', boot, { once: true })
  }
})()
