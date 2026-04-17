import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

import { PluginSettings } from '../packages/core/src/plugin/settings.ts'
import type { SettingsSchema } from '../packages/core/src/plugin/settings-schema.ts'
import {
  renderSettings,
  destroyRender,
} from '../packages/core/src/ui/plugin-settings-renderer.ts'

// ---- DOM setup ---------------------------------------------------------
// Node 22+ exposes `navigator` as a read-only global, so a direct assignment
// throws. defineProperty with configurable:true sidesteps the getter.

let dom: Window
const saved: Record<string, PropertyDescriptor | undefined> = {}

before(() => {
  dom = new Window()
  for (const name of ['window', 'document', 'HTMLElement', 'navigator', 'Event'] as const) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, {
      value: (dom as any)[name] ?? (dom.document as any)[name] ?? undefined,
      configurable: true,
      writable: true,
    })
  }
})

after(() => {
  for (const [name, desc] of Object.entries(saved)) {
    if (desc) Object.defineProperty(globalThis, name, desc)
    else delete (globalThis as any)[name]
  }
  dom.close()
})

// ---- PluginSettings stub (IO-less) -------------------------------------

function makeStubPlatform() {
  const noop = async () => {}
  return {
    path: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (p: string) => p.split('/').slice(0, -1).join('/') || '/',
      basename: (p: string) => p.split('/').pop() ?? '',
      extname: () => '',
      resolve: (...parts: string[]) => parts.join('/'),
      isAbsolute: (p: string) => p.startsWith('/'),
      sep: '/',
    },
    dataDir: '/tmp',
    fs: {
      exists: async () => false,
      readText: async () => '',
      writeText: noop,
      mkdir: noop,
      appendText: noop,
      stat: async () => ({ size: 0, mtimeMs: 0, isDirectory: () => false, isFile: () => true }),
      remove: noop,
      list: async () => [],
      walk: async () => [],
    },
  } as any
}

interface TestShape extends Record<string, unknown> {
  enabled: boolean
  port: number
  mode: string
  host: string
  token: string
}

function makeSettings(overrides: Partial<TestShape> = {}): PluginSettings<TestShape> {
  return new PluginSettings<TestShape>(
    'test-plugin',
    { enabled: false, port: 5619, mode: 'default', host: '127.0.0.1', token: 'deadbeef', ...overrides },
    makeStubPlatform(),
  )
}

const baseCtx = (schema: SettingsSchema<TestShape>, settings = makeSettings()) => ({
  settings,
  schema,
  pluginName: 'Test Plugin',
  pluginVersion: '1.0.0',
  pluginDescription: 'A stub for tests',
  isLoaded: true,
})

// ---- Tests -------------------------------------------------------------

test('empty schema renders a placeholder', () => {
  const root = renderSettings(baseCtx({ fields: {} }))
  const empty = root.querySelector('.tpl-pc-empty-schema')
  assert.ok(empty, 'should show empty-schema placeholder')
  assert.match(empty!.textContent ?? '', /no configurable settings/i)
  destroyRender(root)
})

test('toggle field renders and flips aria-checked on click', () => {
  const settings = makeSettings({ enabled: false })
  const root = renderSettings(baseCtx({
    fields: {
      enabled: { kind: 'toggle', label: 'Enabled' },
    },
  }, settings))

  const btn = root.querySelector('.tpl-pc-toggle') as any
  assert.ok(btn, 'toggle rendered')
  assert.equal(btn.getAttribute('aria-checked'), 'false')

  btn.dispatchEvent(new (globalThis as any).Event('click', { bubbles: true }))
  assert.equal(btn.getAttribute('aria-checked'), 'true')
  destroyRender(root)
})

test('enum with 3 options uses segmented style; 4 uses select', () => {
  const root3 = renderSettings(baseCtx({
    fields: {
      mode: {
        kind: 'enum',
        label: 'Mode',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'wide', label: 'Wide' },
          { value: 'full', label: 'Full' },
        ],
      },
    },
  }))
  assert.ok(root3.querySelector('.tpl-pc-segmented'), '3 options → segmented')
  assert.equal(root3.querySelector('.tpl-pc-select'), null)
  destroyRender(root3)

  const root4 = renderSettings(baseCtx({
    fields: {
      mode: {
        kind: 'enum',
        label: 'Mode',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C' },
          { value: 'd', label: 'D' },
        ],
      },
    },
  }))
  assert.ok(root4.querySelector('.tpl-pc-select'), '4 options → select')
  destroyRender(root4)
})

test('secret field NEVER writes raw value to DOM before Reveal', () => {
  const SENSITIVE = 'super-secret-token-abc123xyz'
  const settings = makeSettings({ token: SENSITIVE })
  const root = renderSettings(baseCtx({
    fields: { token: { kind: 'secret', label: 'Token' } },
  }, settings))

  const html = root.innerHTML
  assert.equal(html.includes(SENSITIVE), false,
    'raw secret must not appear in DOM before Reveal')

  const input = root.querySelector('.tpl-pc-input') as any
  assert.equal(input.value, '', 'input.value stays empty pre-Reveal')
  assert.equal(input.type, 'password')
  destroyRender(root)
})

test('secret field Reveal exposes value, Hide re-masks it', () => {
  const SENSITIVE = 'reveal-me-please-xyz789'
  const settings = makeSettings({ token: SENSITIVE })
  const root = renderSettings(baseCtx({
    fields: { token: { kind: 'secret', label: 'Token' } },
  }, settings))

  const revealBtn = [...root.querySelectorAll('.tpl-pc-btn')]
    .find(b => (b.textContent ?? '').trim() === 'Reveal') as any
  assert.ok(revealBtn, 'Reveal button present')

  revealBtn.dispatchEvent(new (globalThis as any).Event('click', { bubbles: true }))

  const input = root.querySelector('.tpl-pc-input') as any
  assert.equal(input.type, 'text')
  assert.equal(input.value, SENSITIVE)
  assert.equal(revealBtn.textContent, 'Hide')

  // Click again to hide
  revealBtn.dispatchEvent(new (globalThis as any).Event('click', { bubbles: true }))
  assert.equal(input.type, 'password')
  assert.equal(input.value, '')
  assert.equal(revealBtn.textContent, 'Reveal')
  destroyRender(root)
})

test('secret field exposes a Copy button by default', () => {
  const root = renderSettings(baseCtx({
    fields: { token: { kind: 'secret', label: 'Token' } },
  }))
  const copyBtn = [...root.querySelectorAll('.tpl-pc-btn')]
    .find(b => (b.textContent ?? '').trim() === 'Copy')
  assert.ok(copyBtn, 'Copy button must exist per user decision (always present)')
  destroyRender(root)
})

test('section grouping renders a heading per declared section in order', () => {
  const root = renderSettings(baseCtx({
    fields: {
      host: { kind: 'string', label: 'Host', section: 'Network' },
      port: { kind: 'number', label: 'Port', section: 'Network' },
      enabled: { kind: 'toggle', label: 'Shell exec', section: 'Security' },
    },
    sections: {
      Network: { title: 'Network', order: 1 },
      Security: { title: 'Security', order: 2 },
    },
  }))
  const titles = [...root.querySelectorAll('.tpl-pc-section-title')]
    .map(el => el.textContent)
  assert.deepEqual(titles, ['Network', 'Security'])
  destroyRender(root)
})

test('banner renders when plugin is not loaded', () => {
  const root = renderSettings({
    ...baseCtx({ fields: { enabled: { kind: 'toggle', label: 'x' } } }),
    isLoaded: false,
  })
  const banner = root.querySelector('.tpl-pc-banner')
  assert.ok(banner)
  assert.match(banner!.textContent ?? '', /disabled/i)
  destroyRender(root)
})

test('destroyRender clears pending save timers (no crash after timers would have fired)', async () => {
  const settings = makeSettings()
  let saveCalls = 0
  const origSave = settings.save.bind(settings)
  settings.save = async () => { saveCalls++; await origSave() }

  const root = renderSettings(baseCtx({
    fields: { host: { kind: 'string', label: 'Host' } },
  }, settings))
  const input = root.querySelector('.tpl-pc-input') as any
  input.value = 'new-host'
  input.dispatchEvent(new (globalThis as any).Event('input', { bubbles: true }))

  destroyRender(root)
  await new Promise(r => setTimeout(r, 600))

  assert.equal(saveCalls, 0, 'save must not fire after destroy clears the timer')
})
