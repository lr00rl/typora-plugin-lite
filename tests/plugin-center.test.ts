import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as nodePath from 'node:path'
import { Window } from 'happy-dom'

import { PluginCenterPanel } from '../packages/core/src/ui/plugin-center.ts'
import { platform } from '../packages/core/src/platform/index.ts'

let dom: Window
const saved: Record<string, PropertyDescriptor | undefined> = {}

before(() => {
  dom = new Window()
  for (const name of ['window', 'document', 'HTMLElement', 'navigator', 'Event', 'KeyboardEvent', 'MouseEvent'] as const) {
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

beforeEach(() => {
  document.body.replaceChildren()
  document.head.replaceChildren()
  platform.fs.exists = async () => false
  platform.fs.readText = async () => ''
  platform.fs.mkdir = async () => {}
  platform.fs.writeText = async () => {}
  ;(window as any).reqnode = (id: string) => {
    if (id === 'path') return nodePath
    throw new Error(`Unexpected reqnode module: ${id}`)
  }
})

function manifest(id: string, name: string) {
  return { id, name, version: '1.0.0', description: `${name} description`, loading: { startup: true } }
}

function makePanel(options: { enable?: (id: string) => Promise<void> } = {}) {
  const manifests = [manifest('alpha', 'Alpha'), manifest('beta', 'Beta')]
  const loaded = new Set<string>(['alpha'])
  const enabled = new Set<string>(['alpha'])
  class FakePlugin {
    static settingsSchema = {
      fields: {
        enabled: { kind: 'toggle' as const, label: 'Feature enabled' },
        label: { kind: 'string' as const, label: 'Label' },
      },
    }
    static defaultSettings = { enabled: false, label: 'default' }
    settings = { get: (key: string) => key === 'label' ? 'live' : false, getAll: () => ({ enabled: false, label: 'live' }), set: () => {}, save: async () => {} }
  }
  const instances = new Map(manifests.map(item => [item.id, new FakePlugin()]))
  ;(window as any).__tpl = { pluginClasses: Object.fromEntries(manifests.map(item => [item.id, FakePlugin])) }
  const plugins = {
    getManifests: () => manifests,
    isLoaded: (id: string) => loaded.has(id),
    isEnabled: (id: string) => enabled.has(id),
    getPlugin: (id: string) => loaded.has(id) ? instances.get(id) : null,
    disablePlugin: (id: string) => { enabled.delete(id); loaded.delete(id) },
    enablePlugin: async (id: string) => {
      enabled.add(id)
      if (options.enable) await options.enable(id)
      loaded.add(id)
    },
  }
  const hotkeys = { getBindings: () => [] }
  return { panel: new PluginCenterPanel(plugins as any, hotkeys as any), loaded, enabled }
}

test('plugin center exposes modal dialog and semantic plugin selection/toggles', () => {
  const { panel } = makePanel()
  panel.open()

  const dialog = document.querySelector<HTMLElement>('.tpl-plugin-center-panel')!
  assert.equal(dialog.getAttribute('role'), 'dialog')
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  assert.equal(dialog.getAttribute('aria-labelledby'), 'tpl-plugin-center-title')

  const list = document.querySelector('.tpl-plugin-center-list-pane')!
  assert.equal(list.getAttribute('role'), 'list')
  assert.equal(list.getAttribute('aria-label'), 'Plugins')
  const rows = [...document.querySelectorAll<HTMLElement>('.tpl-plugin-center-row')]
  assert.equal(rows[0].getAttribute('role'), 'listitem')
  assert.equal(rows[0].getAttribute('aria-current'), 'true')
  assert.equal(rows[1].getAttribute('aria-current'), null)

  const betaToggle = rows[1].querySelector<HTMLButtonElement>('.tpl-plugin-center-toggle')!
  assert.equal(betaToggle.getAttribute('role'), 'switch')
  assert.equal(betaToggle.getAttribute('aria-checked'), 'false')
  assert.equal(betaToggle.getAttribute('aria-label'), 'Enable Beta')
  rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  assert.equal(rows[0].getAttribute('aria-current'), null)
  assert.equal(rows[1].getAttribute('aria-current'), 'true')
  panel.close()
})

test('close restores focus to the element that opened the dialog', () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  const { panel } = makePanel()
  panel.open()
  assert.notEqual(document.activeElement, trigger)
  panel.close()
  assert.equal(document.activeElement, trigger)
})

test('Tab and Shift+Tab wrap focus inside the dialog', () => {
  const { panel } = makePanel()
  panel.open()
  const dialog = document.querySelector<HTMLElement>('.tpl-plugin-center-panel')!
  const focusable = [...dialog.querySelectorAll<HTMLElement>('[tabindex="0"], button, input, select')]
  const first = focusable[0]
  const last = focusable[focusable.length - 1]

  assert.equal(document.activeElement, dialog)
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
  assert.equal(document.activeElement, last)
  last.focus()
  last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  assert.equal(document.activeElement, first)
  first.focus()
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
  assert.equal(document.activeElement, last)
  panel.close()
})

test('arrow keys inside settings do not unexpectedly change the selected plugin', () => {
  const { panel } = makePanel()
  panel.open()
  const setting = document.querySelector<HTMLButtonElement>('.tpl-pc-detail .tpl-pc-toggle')!
  setting.focus()
  setting.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  const rows = [...document.querySelectorAll<HTMLElement>('.tpl-plugin-center-row')]
  assert.equal(rows[0].getAttribute('aria-current'), 'true')
  assert.equal(rows[1].getAttribute('aria-current'), null)
  panel.close()
})

test('row keyboard activation selects that row without hijacking its nested switch', () => {
  const { panel } = makePanel()
  panel.open()
  const rows = [...document.querySelectorAll<HTMLElement>('.tpl-plugin-center-row')]
  const betaRow = rows[1]!

  betaRow.focus()
  betaRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.equal(betaRow.getAttribute('aria-current'), 'true')

  const betaToggle = betaRow.querySelector<HTMLButtonElement>('.tpl-plugin-center-toggle')!
  betaToggle.focus()
  betaToggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  assert.equal(betaRow.getAttribute('aria-current'), 'true')
  panel.close()
})

test('async enable exposes busy state and keeps a visible actionable error on failure', async () => {
  let rejectEnable!: (reason: Error) => void
  const enable = () => new Promise<void>((_resolve, reject) => { rejectEnable = reject })
  const { panel } = makePanel({ enable })
  panel.open()
  const toggle = document.querySelectorAll<HTMLButtonElement>('.tpl-plugin-center-toggle')[1]

  toggle.click()
  assert.equal(toggle.disabled, true)
  assert.equal(toggle.getAttribute('aria-busy'), 'true')
  assert.match(document.querySelector('.tpl-plugin-center-status')?.textContent ?? '', /enabling beta/i)

  await new Promise(resolve => setTimeout(resolve, 0))
  rejectEnable(new Error('bundle failed'))
  await new Promise(resolve => setTimeout(resolve, 0))
  const status = document.querySelector('.tpl-plugin-center-status')!
  const refreshedToggle = document.querySelectorAll<HTMLButtonElement>('.tpl-plugin-center-toggle')[1]!
  assert.equal(status.getAttribute('role'), 'alert')
  assert.match(status.textContent ?? '', /could not enable beta.*bundle failed/i)
  assert.equal(refreshedToggle.getAttribute('aria-checked'), 'true')
  assert.equal(refreshedToggle.disabled, false)
  panel.close()
})

test('disabled plugin settings load persisted values before the form is mounted', async () => {
  const originalExists = platform.fs.exists
  const originalReadText = platform.fs.readText
  platform.fs.exists = async () => true
  platform.fs.readText = async () => JSON.stringify({ enabled: true, label: 'persisted' })

  try {
    const { panel } = makePanel()
    panel.open()
    const betaRow = document.querySelectorAll<HTMLElement>('.tpl-plugin-center-row')[1]!
    betaRow.click()
    await new Promise(resolve => setTimeout(resolve, 20))

    const detail = document.querySelector<HTMLElement>('.tpl-plugin-center-detail-pane')!
    const input = detail.querySelector<HTMLInputElement>('.tpl-pc-input')
    const toggle = detail.querySelector<HTMLButtonElement>('.tpl-pc-toggle')
    assert.ok(input, detail.innerHTML)
    assert.ok(toggle, detail.innerHTML)
    assert.equal(input.value, 'persisted')
    assert.equal(toggle.getAttribute('aria-checked'), 'true')
    panel.close()
  } finally {
    platform.fs.exists = originalExists
    platform.fs.readText = originalReadText
  }
})

test('enabled lazy plugins are shown as idle rather than disabled', async () => {
  const { panel, enabled } = makePanel()
  enabled.add('beta')
  panel.open()
  const betaRow = document.querySelectorAll<HTMLElement>('.tpl-plugin-center-row')[1]!
  const toggle = betaRow.querySelector<HTMLButtonElement>('.tpl-plugin-center-toggle')!
  assert.equal(toggle.getAttribute('aria-checked'), 'true')
  assert.match(betaRow.getAttribute('aria-label') ?? '', /enabled and idle/i)

  betaRow.click()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.match(document.querySelector('.tpl-pc-banner')?.textContent ?? '', /enabled.*trigger/i)
  panel.close()
})

test('enabling a disabled plugin flushes its pending edit before loading runtime state', async () => {
  let written = ''
  platform.fs.exists = async () => true
  platform.fs.readText = async () => JSON.stringify({ enabled: false, label: 'persisted' })
  platform.fs.writeText = async (_path, text) => { written = text }

  const { panel, loaded } = makePanel({
    enable: async () => {
      assert.equal(JSON.parse(written).label, 'edited-before-enable')
    },
  })
  panel.open()
  const betaRow = document.querySelectorAll<HTMLElement>('.tpl-plugin-center-row')[1]!
  betaRow.click()
  await new Promise(resolve => setTimeout(resolve, 20))

  const input = document.querySelector<HTMLInputElement>('.tpl-plugin-center-detail-pane .tpl-pc-input')!
  input.value = 'edited-before-enable'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  betaRow.querySelector<HTMLButtonElement>('.tpl-plugin-center-toggle')!.click()
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(loaded.has('beta'), true)
  panel.close()
})

test('styles provide narrow single-column layout, visible focus, and reduced motion', () => {
  const { panel } = makePanel()
  panel.open()
  const css = [...document.querySelectorAll('style')].map(el => el.textContent).join('\n')
  assert.match(css, /@media\s*\(max-width:\s*640px\)/)
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(css, /\.tpl-pc-secret-wrap\s*\{[^}]*flex-direction:\s*column/)
  assert.match(css, /\.tpl-pc-secret-actions\s*\{[^}]*flex-wrap:\s*wrap/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.match(css, /--tpl-accent:\s*var\(--tpl-ui-accent,\s*var\(--accent-color,\s*var\(--link-color,/)
  assert.doesNotMatch(css, /--tpl-accent:[^;]*--active-file-bg-color/)
  panel.close()
})
