import * as esbuild from 'esbuild'
import { readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const isWatch = process.argv.includes('--watch')

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
}

// 1. Loader — IIFE (~1KB)
const loaderConfig: esbuild.BuildOptions = {
  ...shared,
  entryPoints: [join(ROOT, 'packages/loader/src/index.ts')],
  outfile: join(DIST, 'loader.js'),
  format: 'iife',
  minify: true,
}

// 2. Core — ESM (dynamically imported by loader)
const coreConfig: esbuild.BuildOptions = {
  ...shared,
  entryPoints: [join(ROOT, 'packages/core/src/index.ts')],
  outfile: join(DIST, 'core.js'),
  format: 'esm',
}

// 3. Each plugin — ESM, core as external
const pluginConfigs: esbuild.BuildOptions[] = pluginEntries.map(p => ({
  ...shared,
  entryPoints: [p.entry],
  outfile: join(DIST, 'plugins', p.name, 'main.js'),
  format: 'esm' as const,
  external: ['@typora-plugin-lite/core'],
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
    console.log(`Built loader + core + ${pluginEntries.length} plugins`)
  }
}

build().catch(err => {
  console.error(err)
  process.exit(1)
})
