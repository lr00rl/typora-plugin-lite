import * as esbuild from 'esbuild'
import { readdirSync, existsSync, copyFileSync, cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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

/**
 * The names exposed to plugins through the @typora-plugin-lite/core shim.
 *
 * The runtime surface is the hand-written `coreExports` object in
 * packages/core/src/index.ts — plugins read window.__tpl.core at RUNTIME, so
 * the shim's export list must match it exactly. A mismatch used to be a
 * silent runtime crash inside Typora (undefined export), invisible to tsc and
 * to the build. So the list is now parsed from that object at build time:
 * one source of truth, and a mismatch becomes impossible by construction.
 */
function coreShimExports(): string[] {
  const src = readFileSync(join(ROOT, 'packages/core/src/index.ts'), 'utf8')
  const match = src.match(/const coreExports = \{([^}]*)\}/s)
  if (!match) throw new Error('coreExports object not found in packages/core/src/index.ts')
  const names = match[1]!
    .split(',')
    .map(part => part.trim())
    .filter(part => /^[A-Za-z_$][\w$]*$/.test(part))
  if (names.length === 0) throw new Error('coreExports parsed to an empty export list')
  return names
}

const tplCoreShimPlugin: esbuild.Plugin = {
  name: 'resolve-tpl-core',
  setup(build) {
    build.onResolve({ filter: /^@typora-plugin-lite\/core$/ }, () => ({
      path: '@typora-plugin-lite/core',
      namespace: 'tpl-core-shim',
    }))
    build.onLoad({ filter: /.*/, namespace: 'tpl-core-shim' }, () => {
      const names = coreShimExports()
      return {
        contents:
          'var c = window.__tpl?.core || {};\n' +
          names.map(name => `export var ${name} = c.${name};`).join('\n') +
          '\n',
        loader: 'js',
      }
    })
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

const sidecarConfigs: esbuild.BuildOptions[] = pluginEntries
  .map(p => ({
    name: p.name,
    entry: [join(ROOT, 'plugins', p.name, 'src', 'sidecar.ts'), join(ROOT, 'plugins', p.name, 'src', 'sidecar', 'server.ts')]
      .find(path => existsSync(path)) ?? null,
  }))
  .filter((item): item is { name: string; entry: string } => item.entry !== null)
  .map(item => ({
    bundle: true,
    sourcemap: true,
    target: 'node22',
    platform: 'node' as const,
    logLevel: 'info' as const,
    minify: isProd,
    entryPoints: [item.entry],
    outfile: join(DIST, 'plugins', item.name, 'bin', 'sidecar.mjs'),
    format: 'esm' as const,
    banner: {
      js: '#!/usr/bin/env node',
    },
  }))

const clientConfigs: esbuild.BuildOptions[] = [
  {
    bundle: true,
    sourcemap: true,
    target: 'node22',
    platform: 'node' as const,
    logLevel: 'info' as const,
    minify: isProd,
    entryPoints: [join(ROOT, 'clients/node/src/index.ts')],
    outfile: join(DIST, 'clients', 'node', 'index.mjs'),
    format: 'esm' as const,
  },
]

async function build() {
  if (isWatch) {
    const contexts = await Promise.all([
      esbuild.context(loaderConfig),
      esbuild.context(coreConfig),
      ...pluginConfigs.map(c => esbuild.context(c)),
      ...sidecarConfigs.map(c => esbuild.context(c)),
      ...clientConfigs.map(c => esbuild.context(c)),
    ])
    await Promise.all(contexts.map(ctx => ctx.watch()))
    console.log('Watching for changes...')
  } else {
    await Promise.all([
      esbuild.build(loaderConfig),
      esbuild.build(coreConfig),
      ...pluginConfigs.map(c => esbuild.build(c)),
      ...sidecarConfigs.map(c => esbuild.build(c)),
      ...clientConfigs.map(c => esbuild.build(c)),
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
