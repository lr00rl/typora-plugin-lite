import * as esbuild from 'esbuild'
import { readdirSync, existsSync, copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = join(ROOT, 'dist')
const isWatch = process.argv.includes('--watch')
const isProd = process.argv.includes('--prod')

// Discover plugins
const PLUGINS_DIR = join(ROOT, 'plugins')
const pluginEntries = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(PLUGINS_DIR, d.name, 'src', 'main.ts')))
  .map(d => ({
    name: d.name,
    entry: join(PLUGINS_DIR, d.name, 'src', 'main.ts'),
  }))

// Shared esbuild options
const shared: esbuild.BuildOptions = {
  bundle: true,
  sourcemap: true,
  target: 'es2022',
  loader: { '.css': 'text' },
  logLevel: 'info',
  minify: isProd,
}

// 1. Loader — IIFE (injects <script> tags, no ESM import())
const loaderConfig: esbuild.BuildOptions = {
  ...shared,
  entryPoints: [join(ROOT, 'packages/loader/src/index.ts')],
  outfile: join(DIST, 'loader.js'),
  format: 'iife',
}

// 2. Core — IIFE (WKWebView doesn't support file:// ESM import())
//    Registers on window.__tpl for loader + plugins to access
const coreConfig: esbuild.BuildOptions = {
  ...shared,
  entryPoints: [join(ROOT, 'packages/core/src/index.ts')],
  outfile: join(DIST, 'core.js'),
  format: 'iife',
}

// 3. Each plugin — IIFE, accesses core via window.__tpl.core
//    Plugin IIFE auto-registers its default export on window.__tpl.pluginClasses[id]
const tplCoreShimPlugin: esbuild.Plugin = {
  name: 'resolve-tpl-core',
  setup(build) {
    build.onResolve({ filter: /^@typora-plugin-lite\/core$/ }, () => ({
      path: '@typora-plugin-lite/core',
      namespace: 'tpl-core-shim',
    }))
    build.onLoad({ filter: /.*/, namespace: 'tpl-core-shim' }, () => ({
      contents: `
        var c = window.__tpl?.core || {};
        export var Plugin = c.Plugin;
        export var editor = c.editor;
        export var platform = c.platform;
        export var IS_MAC = c.IS_MAC;
        export var IS_NODE = c.IS_NODE;
        export var getApp = c.getApp;
        export var EventBus = c.EventBus;
        export var HotkeyManager = c.HotkeyManager;
        export var PluginManager = c.PluginManager;
        export var PluginSettings = c.PluginSettings;
      `,
      loader: 'js',
    }))
  },
}

const pluginConfigs: esbuild.BuildOptions[] = pluginEntries.map(p => ({
  ...shared,
  entryPoints: [p.entry],
  outfile: join(DIST, 'plugins', p.name, 'main.js'),
  format: 'iife' as const,
  globalName: `__tpl_plugin_${p.name.replace(/-/g, '_')}`,
  footer: {
    // After the IIFE runs, register the default export class
    js: [
      `;(function() {`,
      `  window.__tpl = window.__tpl || {};`,
      `  window.__tpl.pluginClasses = window.__tpl.pluginClasses || {};`,
      `  var m = __tpl_plugin_${p.name.replace(/-/g, '_')};`,
      `  var cls = m && (m.default || m[Object.keys(m)[0]]);`,
      `  if (cls) window.__tpl.pluginClasses["${p.name}"] = cls;`,
      `  console.log("[tpl:plugin]", "${p.name}", cls ? "registered" : "FAILED to register");`,
      `})();`,
    ].join('\n'),
  },
  plugins: [tplCoreShimPlugin],
}))

async function build() {
  if (isWatch) {
    const contexts = await Promise.all([
      esbuild.context(loaderConfig),
      esbuild.context(coreConfig),
      ...pluginConfigs.map(c => esbuild.context(c)),
    ])
    await Promise.all(contexts.map(ctx => ctx.watch()))
    console.log('Watching for changes...')
  } else {
    await Promise.all([
      esbuild.build(loaderConfig),
      esbuild.build(coreConfig),
      ...pluginConfigs.map(c => esbuild.build(c)),
    ])
    // Copy plugin manifests to dist
    for (const p of pluginEntries) {
      const src = join(PLUGINS_DIR, p.name, 'manifest.json')
      if (existsSync(src)) {
        const destDir = join(DIST, 'plugins', p.name)
        mkdirSync(destDir, { recursive: true })
        copyFileSync(src, join(destDir, 'manifest.json'))
      }

      const binDir = join(PLUGINS_DIR, p.name, 'bin')
      if (existsSync(binDir)) {
        const destDir = join(DIST, 'plugins', p.name, 'bin')
        mkdirSync(join(DIST, 'plugins', p.name), { recursive: true })
        cpSync(binDir, destDir, { recursive: true })
      }
    }
    // Write builtin plugin manifest for installer to know which plugins to clean
    writeFileSync(
      join(DIST, 'builtin-plugins.json'),
      JSON.stringify(pluginEntries.map(p => p.name), null, 2) + '\n',
    )
    console.log(`Built loader + core + ${pluginEntries.length} plugins`)
  }
}

build().catch(err => {
  console.error(err)
  process.exit(1)
})
