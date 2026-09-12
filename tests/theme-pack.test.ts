import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Window } from 'happy-dom'

import {
  hrefBaseName,
  isDarkMode,
  reloadManagedThemeIfActive,
  refreshTyporaThemeCatalog,
} from '../plugins/theme-pack/src/activate.ts'
import { NodeHttpClient, createHttpClient, parseEtag } from '../plugins/theme-pack/src/http.ts'
import { BOOTLOADER_TYPE, parseThemePack } from '../plugins/theme-pack/src/pack.ts'
import { pathToFileUrl, resolveThemesDir } from '../plugins/theme-pack/src/paths.ts'
import { parseThemeSource } from '../plugins/theme-pack/src/source.ts'
import { packUpdated, syncThemePack, type SyncDeps } from '../plugins/theme-pack/src/sync.ts'

const BOOTLOADER = {
  typ: BOOTLOADER_TYPE,
  version: 1,
  name: 'Claude Like',
} as const

function packJson(files: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...BOOTLOADER,
    files: files.map(path => ({ path })),
    ...extra,
  })
}

test('parses GitHub repos, blob URLs, short names, and local folders', () => {
  const homedir = '/Users/cdcd'
  assert.deepEqual(
    parseThemeSource('https://github.com/lr00rl/Typora_Claude-Like_Theme', { homedir, ref: 'main' }),
    { kind: 'github', owner: 'lr00rl', repo: 'Typora_Claude-Like_Theme', ref: 'main' },
  )
  assert.deepEqual(
    parseThemeSource('lr00rl/Typora_Claude-Like_Theme.git', { homedir, ref: 'main' }),
    { kind: 'github', owner: 'lr00rl', repo: 'Typora_Claude-Like_Theme', ref: 'main' },
  )
  assert.deepEqual(
    parseThemeSource('https://github.com/lr00rl/Typora_Claude-Like_Theme/tree/v1.2.2', { homedir }),
    { kind: 'github', owner: 'lr00rl', repo: 'Typora_Claude-Like_Theme', ref: 'v1.2.2' },
  )
  assert.deepEqual(
    parseThemeSource('https://github.com/lr00rl/Typora_Claude-Like_Theme/blob/main/claude-like.css', { homedir }),
    { kind: 'github', owner: 'lr00rl', repo: 'Typora_Claude-Like_Theme', ref: 'main' },
  )
  assert.deepEqual(
    parseThemeSource('https://raw.githubusercontent.com/lr00rl/Typora_Claude-Like_Theme/main/claude-like-dark.css', { homedir }),
    { kind: 'github', owner: 'lr00rl', repo: 'Typora_Claude-Like_Theme', ref: 'main' },
  )
  assert.deepEqual(
    parseThemeSource('~/roobli/lr00rl/Typora_Claude-Like_Theme', { homedir }),
    { kind: 'local', dir: '/Users/cdcd/roobli/lr00rl/Typora_Claude-Like_Theme' },
  )
  assert.deepEqual(
    parseThemeSource('C:/Users/cdcd/Typora_Claude-Like_Theme', { homedir: 'C:/Users/cdcd' }),
    { kind: 'local', dir: 'C:/Users/cdcd/Typora_Claude-Like_Theme' },
  )
  assert.equal(
    parseThemeSource('', { homedir }).kind,
    'github',
  )
  assert.throws(() => parseThemeSource('javascript:alert(1)', { homedir }))
  assert.throws(
    () => parseThemeSource('https://gitlab.com/someone/theme', { homedir }),
    /GitHub repository/,
  )
})

test('theme-pack.json requires the bootloader and only root-level css files', () => {
  const pack = parseThemePack(packJson(
    ['claude-like.css', 'claude-like-dark.css'],
    { light: 'claude-like.css', dark: 'claude-like-dark.css' },
  ))
  assert.equal(pack.files.length, 2)
  assert.equal(pack.light, 'claude-like.css')
  assert.throws(() => parseThemePack(JSON.stringify({ files: [{ path: 'claude-like.css' }] })))
  assert.throws(() => parseThemePack(packJson(['../secret.css'])))
  assert.throws(() => parseThemePack(packJson(['session/agent.css'])))
  assert.throws(() => parseThemePack(JSON.stringify({
    typ: BOOTLOADER_TYPE,
    version: 2,
    files: [{ path: 'claude-like.css' }],
  })))
})

test('resolves the official Typora themes folder per OS', () => {
  assert.equal(
    resolveThemesDir({ isMac: true, homedir: '/Users/cdcd' }),
    '/Users/cdcd/Library/Application Support/abnerworks.Typora/themes',
  )
  assert.equal(
    resolveThemesDir({ isMac: false, homedir: '/home/cdcd', nodePlatform: 'linux' }),
    '/home/cdcd/.config/Typora/themes',
  )
  assert.equal(
    resolveThemesDir({
      isMac: false,
      homedir: '/home/cdcd',
      userPath: '/home/cdcd/.config/Typora',
      nodePlatform: 'linux',
    }),
    '/home/cdcd/.config/Typora/themes',
  )
  assert.equal(
    resolveThemesDir({
      isMac: false,
      homedir: 'C:/Users/cdcd',
      nodePlatform: 'win32',
      appData: 'C:/Users/cdcd/AppData/Roaming',
    }),
    'C:/Users/cdcd/AppData/Roaming/Typora/themes',
  )
  assert.equal(
    resolveThemesDir({
      isMac: false,
      homedir: 'C:/Users/cdcd',
      userDataPath: 'C:/Users/cdcd/AppData/Roaming/Typora',
      nodePlatform: 'win32',
    }),
    'C:/Users/cdcd/AppData/Roaming/Typora/themes',
  )
  assert.equal(
    pathToFileUrl('/Users/cdcd/Library/Application Support/abnerworks.Typora/themes/claude-like.css'),
    'file:///Users/cdcd/Library/Application%20Support/abnerworks.Typora/themes/claude-like.css',
  )
  assert.equal(
    pathToFileUrl('C:/Users/cdcd/AppData/Roaming/Typora/themes/claude-like.css'),
    'file:///C:/Users/cdcd/AppData/Roaming/Typora/themes/claude-like.css',
  )
})

test('reloads the active stylesheet only when it is already a pack file', () => {
  const dom = new Window()
  const doc = dom.document as unknown as Document
  doc.body.className = ''
  const existing = doc.createElement('link')
  existing.id = 'theme_css'
  existing.rel = 'stylesheet'
  existing.setAttribute('href', 'file:///tmp/github.css')
  doc.head.appendChild(existing)
  assert.equal(isDarkMode(doc), false)
  assert.equal(hrefBaseName('typora://app/userData/themes/claude-like.css'), 'claude-like.css')
  assert.equal(
    reloadManagedThemeIfActive(doc, ['claude-like.css']),
    false,
  )
  assert.equal((doc.getElementById('theme_css') as HTMLLinkElement).getAttribute('href'), 'file:///tmp/github.css')

  existing.setAttribute('href', 'file:///tmp/themes/claude-like.css')
  assert.equal(reloadManagedThemeIfActive(doc, ['claude-like.css']), true)
  assert.equal(doc.querySelectorAll('link[rel="stylesheet"]').length, 1)
  assert.match(
    (doc.getElementById('theme_css') as HTMLLinkElement).getAttribute('href') ?? '',
    /claude-like\.css\?tpl=/,
  )
})

test('asks Typora to refresh the Themes menu without switching theme', () => {
  const invoked: string[] = []
  refreshTyporaThemeCatalog({
    JSBridge: { invoke: (name: string) => { invoked.push(name) } },
    bridge: { callHandler: (name: string) => { invoked.push(name) } },
  })
  assert.deepEqual(invoked, ['menu.refreshThemeMenu', 'menu.updateMenu'])
})

test('sync writes new CSS, skips 304, and never overwrites a symlink', async () => {
  const files = new Map<string, string>([
    ['/checkout/theme-pack.json', packJson(['claude-like.css'], { light: 'claude-like.css' })],
    ['/checkout/claude-like.css', ':root { color: wheat; }'],
  ])
  const symlinks = new Set<string>(['/themes/keep.css'])
  const deps: SyncDeps = {
    join: (...parts: string[]) => parts.join('/').replace(/\/{2,}/g, '/'),
    isSymlink: async (path) => symlinks.has(path),
    fs: {
      exists: async (path) => files.has(path),
      mkdir: async () => {},
      readText: async (path) => {
        const value = files.get(path)
        if (value === undefined) throw new Error(`missing ${path}`)
        return value
      },
      writeText: async (path, text) => { files.set(path, text) },
      copy: async (src, dest) => {
        const value = files.get(src)
        if (value === undefined) throw new Error(`missing ${src}`)
        files.set(dest, value)
      },
    },
  }

  const local = await syncThemePack(
    { kind: 'local', dir: '/checkout' },
    '/themes',
    deps,
  )
  assert.equal(local.files[0]?.action, 'written')
  assert.equal(files.get('/themes/claude-like.css'), ':root { color: wheat; }')
  assert.equal(packUpdated(local), true)

  const again = await syncThemePack(
    { kind: 'local', dir: '/checkout' },
    '/themes',
    deps,
  )
  assert.equal(again.files[0]?.action, 'unchanged')
  assert.equal(packUpdated(again), false)

  files.set('/themes/keep.css', 'old')
  const remote = await syncThemePack(
    { kind: 'github', owner: 'lr00rl', repo: 'Typora_Claude-Like_Theme', ref: 'main' },
    '/themes',
    {
      ...deps,
      http: {
        getText: async () => ({ status: 200, body: packJson(['keep.css']), etag: null }),
        download: async () => {
          throw new Error('should not download over a symlink')
        },
      },
    },
  )
  assert.equal(remote.files[0]?.action, 'symlink')
  assert.equal(files.get('/themes/keep.css'), 'old')
})

test('remote sync honors If-None-Match 304 and refuses a missing bootloader', async () => {
  const files = new Map<string, string>([
    ['/themes/claude-like.css', 'cached'],
  ])
  let sawEtag = ''
  const result = await syncThemePack(
    { kind: 'github', owner: 'lr00rl', repo: 'Typora_Claude-Like_Theme', ref: 'main' },
    '/themes',
    {
      join: (...parts: string[]) => parts.join('/'),
      isSymlink: async () => false,
      fs: {
        exists: async (path) => files.has(path),
        mkdir: async () => {},
        readText: async (path) => files.get(path) ?? '',
        writeText: async (path, text) => { files.set(path, text) },
        copy: async () => {},
      },
      http: {
        getText: async () => ({ status: 200, body: packJson(['claude-like.css']), etag: null }),
        download: async (_url, _dest, etag) => {
          sawEtag = etag ?? ''
          return { status: 304, etag: etag ?? null }
        },
      },
    },
    {
      source: 'https://github.com/lr00rl/Typora_Claude-Like_Theme',
      ref: 'main',
      files: { 'claude-like.css': { etag: '"abc"', kind: 'written' } },
      checkedAt: 1,
    },
  )
  assert.equal(sawEtag, '"abc"')
  assert.equal(result.files[0]?.action, 'unchanged')
  assert.equal(files.get('/themes/claude-like.css'), 'cached')

  await assert.rejects(
    () => syncThemePack(
      { kind: 'github', owner: 'nope', repo: 'missing', ref: 'main' },
      '/themes',
      {
        join: (...parts: string[]) => parts.join('/'),
        isSymlink: async () => false,
        fs: {
          exists: async () => false,
          mkdir: async () => {},
          readText: async () => '',
          writeText: async () => {},
          copy: async () => {},
        },
        http: {
          getText: async () => ({ status: 404, body: '', etag: null }),
          download: async () => ({ status: 404, etag: null }),
        },
      },
    ),
    /bootloader/,
  )
})

test('parses HTTP etags from curl headers', () => {
  assert.equal(parseEtag('Content-Type: text/css\nETag: "abc123"\n'), '"abc123"')
  assert.equal(parseEtag('etag: W/"weak"\n'), 'W/"weak"')
})

test('Node HTTPS client follows redirects, writes dest, and honors 304', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tpl-theme-pack-'))
  const dest = join(root, 'claude-like.css')
  try {
    const calls: string[] = []
    const https = {
      get(url: string, _opts: { headers?: Record<string, string> }, cb: (res: {
        statusCode?: number
        headers: { location?: string; etag?: string }
        on(event: string, listener: (...args: unknown[]) => void): unknown
        resume?: () => void
      }) => void) {
        calls.push(url)
        const req = {
          on() { return req },
          destroy() {},
          setTimeout() {},
        }
        queueMicrotask(() => {
          if (url.endsWith('/from')) {
            cb({
              statusCode: 302,
              headers: { location: 'https://raw.githubusercontent.com/owner/repo/main/to.css' },
              on() { return this },
              resume() {},
            })
            return
          }
          if (url.endsWith('/to.css')) {
            const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
            cb({
              statusCode: 200,
              headers: { etag: '"n1"' },
              on(event, listener) {
                listeners[event] = listeners[event] ?? []
                listeners[event]!.push(listener)
                if (event === 'data') listener(Buffer.from(':root{}'))
                if (event === 'end') listener()
                return this
              },
            })
            return
          }
          cb({
            statusCode: 304,
            headers: { etag: '"n1"' },
            on(event, listener) {
              if (event === 'end') listener()
              return this
            },
          })
        })
        return req
      },
    }
    const client = new NodeHttpClient(https, {
      mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
      writeFileSync,
    })
    const downloaded = await client.download('https://raw.githubusercontent.com/owner/repo/main/from', dest)
    assert.equal(downloaded.status, 200)
    assert.equal(readFileSync(dest, 'utf8'), ':root{}')
    const skipped = await client.download('https://raw.githubusercontent.com/owner/repo/main/cached.css', dest, '"n1"')
    assert.equal(skipped.status, 304)
    assert.equal(readFileSync(dest, 'utf8'), ':root{}')
    assert.equal(calls.length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows/Linux HTTP factory refuses curl fallback when Node https is missing', () => {
  assert.throws(
    () => createHttpClient({
      preferNode: true,
      reqnode: () => undefined,
      shell: { run: async () => '', escape: (text) => text },
      fs: {
        mkdir: async () => {},
        readText: async () => '',
        copy: async () => {},
        remove: async () => {},
      },
      tmpDir: '/tmp',
      cwd: '/tmp',
    }),
    /Node https/,
  )
})
