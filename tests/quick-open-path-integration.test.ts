import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Window } from 'happy-dom'

const require = createRequire(import.meta.url)

/**
 * Drives the real plugin against a stubbed filesystem: builds the actual modal,
 * runs the actual renderList dispatch, and reads the rows out of the DOM. This
 * is what proves the wiring (trigger → parse → list → rows → activation), which
 * the pure grammar tests deliberately do not cover.
 */
async function harness() {
  const dom = new Window({ url: 'https://localhost/' })
  let pendingFrame: FrameRequestCallback | null = null
  class TestResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(dom, 'ResizeObserver', { value: TestResizeObserver, configurable: true })
  Object.defineProperty(dom, 'requestAnimationFrame', {
    value: (cb: FrameRequestCallback) => { pendingFrame = cb; return 17 },
    configurable: true,
  })
  Object.defineProperty(dom, 'cancelAnimationFrame', { value: () => { pendingFrame = null }, configurable: true })
  // Typora exposes node modules through window.reqnode; the core path helper
  // resolves through it lazily.
  Object.defineProperty(dom, 'reqnode', {
    value: (name: string) => require(name),
    configurable: true,
  })

  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const name of ['window', 'document', 'HTMLElement', 'navigator', 'Event', 'KeyboardEvent', 'MouseEvent'] as const) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      value: (dom as any)[name] ?? (dom.document as any)[name],
      configurable: true,
      writable: true,
    })
  }

  const { default: QuickOpenPlugin } = await import('../plugins/fuzzy-search/src/main.ts')
  const { platform } = await import('@typora-plugin-lite/core')

  const TREE: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
    '/vault': [
      { name: 'A000_Theory', isDirectory: true },
      { name: '.obsidian', isDirectory: true },
      { name: 'zeta.md', isDirectory: false },
      { name: 'alpha.md', isDirectory: false },
      { name: '.DS_Store', isDirectory: false },
    ],
    '/vault/A000_Theory': [{ name: 'A300_AI', isDirectory: true }, { name: 'index.md', isDirectory: false }],
    '/': [{ name: 'Users', isDirectory: true }, { name: 'etc', isDirectory: true }],
  }
  const asked: string[] = []
  const originalListEntries = platform.fs.listEntries
  platform.fs.listEntries = async (dir: string) => {
    asked.push(dir)
    const hit = TREE[dir]
    if (!hit) throw new Error(`ENOENT ${dir}`)
    return hit
  }

  const plugin = new QuickOpenPlugin() as any
  plugin.addDisposable = () => {}
  plugin.buildModal()
  plugin.getRootDir = () => '/vault'

  const rows = () => [...document.querySelectorAll('.tpl-qo-item')].map(el => ({
    name: el.querySelector('.tpl-qo-name')?.textContent?.trim() ?? '',
    meta: el.querySelector('.tpl-qo-path')?.textContent?.trim() ?? '',
    isDir: el.classList.contains('tpl-qo-dir'),
  }))
  const location = () => document.querySelector('.tpl-qo-location')?.textContent ?? ''
  const footer = () => document.querySelector('#tpl-qo-footer-text')?.textContent ?? ''

  const restore = () => {
    platform.fs.listEntries = originalListEntries
    for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  }
  return { plugin, rows, location, footer, asked, restore, flush: () => { const cb = pendingFrame; pendingFrame = null; cb?.(0) } }
}

test('a single slash lists the open folder, folders first, dotfiles hidden', async () => {
  const h = await harness()
  try {
    await h.plugin.renderList('/')
    assert.match(h.location(), /\/vault/, 'the location bar shows the absolute directory')
    assert.deepEqual(h.rows().map(r => r.name), ['A000_Theory', 'alpha.md', 'zeta.md'])
    assert.equal(h.rows()[0]!.isDir, true)
    assert.equal(h.rows()[0]!.meta, '目录')
    assert.equal(h.rows()[1]!.meta, 'md', 'files show their extension')
    assert.match(h.footer(), /2 项隐藏/, 'hidden entries are reported, never silently dropped')
  } finally { h.restore() }
})

test('typing a dot reveals the hidden entries', async () => {
  const h = await harness()
  try {
    await h.plugin.renderList('/.')
    assert.deepEqual(h.rows().map(r => r.name), ['.obsidian', '.DS_Store'])
  } finally { h.restore() }
})

test('a partial final segment filters the parent listing', async () => {
  const h = await harness()
  try {
    await h.plugin.renderList('/al')
    assert.deepEqual(h.asked.at(-1), '/vault', 'it lists the parent, not the partial path')
    assert.deepEqual(h.rows().map(r => r.name), ['alpha.md'])
  } finally { h.restore() }
})

test('two slashes reach the filesystem root instead of the vault', async () => {
  const h = await harness()
  try {
    await h.plugin.renderList('//')
    assert.equal(h.asked.at(-1), '/')
    // Both are directories, so they sort case-insensitively by name the way
    // Finder does: 'etc' before 'Users', not the order the filesystem returned.
    assert.deepEqual(h.rows().map(r => r.name), ['etc', 'Users'])
    assert.match(h.location(), /文件系统/)
  } finally { h.restore() }
})

test('the 目录 tab tokens do not block the trigger', async () => {
  const h = await harness()
  try {
    await h.plugin.renderList('type:folder scope:A000/ //')
    assert.equal(h.asked.at(-1), '/', 'a slash typed after the tab-authored tokens still enters path mode')
  } finally { h.restore() }
})

test('activating a directory row extends the path and re-lists', async () => {
  const h = await harness()
  try {
    h.plugin.inputEl.value = '/'
    await h.plugin.renderList('/')
    h.plugin.selectedIdx = 0                 // A000_Theory
    h.plugin.activateRow()
    assert.equal(h.plugin.inputEl.value, '/A000_Theory/', 'drilling types the segment for you')
    await new Promise(r => setTimeout(r, 0))
    assert.equal(h.asked.at(-1), '/vault/A000_Theory')
  } finally { h.restore() }
})

test('an unreadable directory reports itself instead of rendering an empty list', async () => {
  const h = await harness()
  try {
    await h.plugin.renderList('/nope/')
    assert.equal(h.rows().length, 0)
    assert.match(document.querySelector('.tpl-qo-list')?.textContent ?? document.body.textContent ?? '', /无法读取这个目录/)
  } finally { h.restore() }
})

test('leaving path mode returns the list to normal search', async () => {
  const h = await harness()
  try {
    await h.plugin.renderList('//')
    assert.ok(h.rows().length > 0)
    h.plugin.renderRecents = async () => { document.querySelector('#tpl-qo-list')!.textContent = 'RECENTS' }
    await h.plugin.renderList('')
    assert.equal(document.querySelector('.tpl-qo-location'), null, 'the location bar is gone')
  } finally { h.restore() }
})
