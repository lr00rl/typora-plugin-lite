import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { posix as path } from 'node:path'
import { Window } from 'happy-dom'

import { EventBus } from '../packages/core/src/plugin/events.ts'
import { HotkeyManager } from '../packages/core/src/hotkey/manager.ts'
import { PluginManager } from '../packages/core/src/plugin/manager.ts'
import type { PluginManifest } from '../packages/core/src/plugin/manifest.ts'
import { Plugin } from '../packages/core/src/plugin/plugin.ts'

let dom: Window
let nativeAppendChild: typeof document.head.appendChild
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

before(() => {
  dom = new Window({ settings: { disableJavaScriptFileLoading: true } })
  for (const name of ['window', 'document', 'HTMLElement', 'Event', 'KeyboardEvent'] as const) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      value: (dom as any)[name] ?? (dom.document as any)[name],
      configurable: true,
      writable: true,
    })
  }
  nativeAppendChild = document.head.appendChild.bind(document.head)
})

after(() => {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as any)[name]
  }
  dom.close()
})

beforeEach(() => {
  document.head.appendChild = nativeAppendChild
  document.head.replaceChildren()
  document.body.replaceChildren()
  ;(window as any).__tpl = { pluginClasses: {} }
})

function manifest(id: string, loading: PluginManifest['loading']): PluginManifest {
  return { id, name: id, version: '1.0.0', loading }
}

class TestPlugin extends Plugin {
  onload(): void {}
}

function createHarness(manifests: PluginManifest[], extraFolders: string[] = []) {
  const files = new Map<string, string>()
  const writes: string[] = []
  for (const item of manifests) {
    files.set(`/plugins/${item.id}/manifest.json`, JSON.stringify(item))
  }

  const platform = {
    builtinPluginsDir: '',
    pluginsDir: '/plugins',
    baseUrl: 'file:///tpl',
    dataDir: '/data',
    path,
    shell: {},
    fs: {
      exists: async (file: string) => files.has(file),
      stat: async () => { throw new Error('unused') },
      isDirectory: async () => false,
      mkdir: async () => {},
      list: async (dir: string) => dir === '/plugins'
        ? [...manifests.map(item => item.id), ...extraFolders]
        : [],
      walkDir: async () => [],
      readText: async (file: string) => {
        const value = files.get(file)
        if (value === undefined) throw new Error(`missing ${file}`)
        return value
      },
      readTextSync: () => '',
      writeText: async (file: string, text: string) => {
        writes.push(text)
        files.set(file, text)
      },
      appendText: async () => {},
      remove: async () => {},
      copy: async () => {},
    },
  }

  const makeManager = () => {
    const events = new EventBus()
    const hotkeys = new HotkeyManager()
    const manager = new PluginManager({ platform: platform as never, events, hotkeys, editor: {} })
    return { manager, events, hotkeys }
  }

  for (const item of manifests) (window as any).__tpl.pluginClasses[item.id] = TestPlugin

  document.head.appendChild = ((node: Node) => {
    if (node instanceof (window as any).HTMLScriptElement) (node as HTMLScriptElement).removeAttribute('src')
    const result = nativeAppendChild(node)
    if (node instanceof (window as any).HTMLScriptElement) {
      queueMicrotask(() => (node as HTMLScriptElement).onload?.(new Event('load')))
    }
    return result
  }) as typeof document.head.appendChild

  return { files, writes, makeManager }
}

test('disabled state survives a new manager instance and skips startup loading', async () => {
  const harness = createHarness([manifest('startup-plugin', { startup: true })])
  const first = harness.makeManager()
  await first.manager.scanAndLoad()
  await first.manager.disablePlugin('startup-plugin')

  const second = harness.makeManager()
  await second.manager.scanAndLoad()

  assert.equal(second.manager.isEnabled('startup-plugin'), false)
  assert.deepEqual(second.manager.getPluginState('startup-plugin'), {
    desiredEnabled: false,
    loaded: false,
    loading: false,
    error: null,
  })
  assert.equal(document.head.querySelectorAll('script').length, 1, 'restart must not inject another startup script')
})

test('disabled plugins do not retain manager-owned event or hotkey lazy triggers', async () => {
  const harness = createHarness([
    manifest('lazy-plugin', { event: ['editor:ready'], hotkey: ['Mod+K'] }),
  ])
  const first = harness.makeManager()
  await first.manager.scanAndLoad()
  await first.manager.disablePlugin('lazy-plugin')

  const { manager, events, hotkeys } = harness.makeManager()
  await manager.scanAndLoad()

  events.emit('editor:ready')
  hotkeys.trigger('Mod+K')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(manager.isLoaded('lazy-plugin'), false)
  assert.deepEqual(hotkeys.getBindings(), [])
  assert.equal(document.head.querySelectorAll('script').length, 0)
})

test('an event lazy trigger is removed before replay and loads only once', async () => {
  const harness = createHarness([manifest('event-plugin', { event: ['editor:ready'] })])
  const { manager, events } = harness.makeManager()
  let replayCount = 0
  let loadCount = 0
  class EventPlugin extends Plugin {
    onload(): void {
      loadCount += 1
      this.registerEvent('editor:ready', () => { replayCount += 1 })
    }
  }
  ;(window as any).__tpl.pluginClasses['event-plugin'] = EventPlugin
  await manager.scanAndLoad()

  events.emit('editor:ready')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(loadCount, 1)
  assert.equal(replayCount, 1)
  assert.equal(document.head.querySelectorAll('script').length, 1)
})

test('enable rejects when loading fails while preserving explicit enabled intent and error state', async () => {
  const harness = createHarness([manifest('broken-plugin', {})])
  const { manager } = harness.makeManager()
  await manager.scanAndLoad()
  await manager.disablePlugin('broken-plugin')

  document.head.appendChild = ((node: Node) => {
    if (node instanceof (window as any).HTMLScriptElement) (node as HTMLScriptElement).removeAttribute('src')
    const result = nativeAppendChild(node)
    queueMicrotask(() => (node as HTMLScriptElement).onerror?.(new Event('error')))
    return result
  }) as typeof document.head.appendChild

  await assert.rejects(manager.enablePlugin('broken-plugin'), /failed to load/i)
  assert.equal(manager.isEnabled('broken-plugin'), true)
  assert.equal(manager.isLoaded('broken-plugin'), false)
  assert.match(manager.getPluginState('broken-plugin')?.error ?? '', /failed to load/i)
})

test('enable loads immediately and persists enabled intent for the next manager instance', async () => {
  const harness = createHarness([manifest('idle-plugin', {})])
  const first = harness.makeManager()
  await first.manager.scanAndLoad()
  await first.manager.disablePlugin('idle-plugin')

  await first.manager.enablePlugin('idle-plugin')
  assert.equal(first.manager.isLoaded('idle-plugin'), true)
  assert.equal(first.manager.isEnabled('idle-plugin'), true)

  const second = harness.makeManager()
  await second.manager.scanAndLoad()
  assert.equal(second.manager.isEnabled('idle-plugin'), true)
  assert.equal(second.manager.isLoaded('idle-plugin'), false, 'an enabled lazy plugin may remain runtime-idle')
})

test('persistence writes are serialized and a failed write does not report a successful transition', async () => {
  const harness = createHarness([manifest('lazy-plugin', {})])
  const { manager } = harness.makeManager()
  await manager.scanAndLoad()

  let releaseWrite!: () => void
  const blocked = new Promise<void>(resolve => { releaseWrite = resolve })
  let call = 0
  const originalWrite = (manager as any).platform.fs.writeText
  ;(manager as any).platform.fs.writeText = async (file: string, text: string) => {
    call += 1
    if (call === 1) await blocked
    if (call === 2) throw new Error('disk full')
    await originalWrite(file, text)
  }

  const disable = manager.disablePlugin('lazy-plugin')
  const enable = manager.enablePlugin('lazy-plugin')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(call, 1, 'second state write must wait for the first')
  releaseWrite()

  await disable
  await assert.rejects(enable, /disk full/)
  assert.equal(manager.isEnabled('lazy-plugin'), false)
})

test('disable then enable during an in-flight lazy load ends enabled and loaded', async () => {
  const harness = createHarness([manifest('racy-plugin', { event: ['editor:ready'] })])
  const { manager, events } = harness.makeManager()
  await manager.scanAndLoad()

  let releaseFirstLoad!: () => void
  let firstLoadStarted!: () => void
  const firstLoad = new Promise<void>(resolve => { releaseFirstLoad = resolve })
  const firstScriptAppended = new Promise<void>(resolve => { firstLoadStarted = resolve })
  let scripts = 0
  document.head.appendChild = ((node: Node) => {
    if (node instanceof (window as any).HTMLScriptElement) (node as HTMLScriptElement).removeAttribute('src')
    const result = nativeAppendChild(node)
    scripts += 1
    if (scripts === 1) {
      firstLoadStarted()
      void firstLoad.then(() => (node as HTMLScriptElement).onload?.(new Event('load')))
    } else {
      queueMicrotask(() => (node as HTMLScriptElement).onload?.(new Event('load')))
    }
    return result
  }) as typeof document.head.appendChild

  events.emit('editor:ready')
  await firstScriptAppended
  const disable = manager.disablePlugin('racy-plugin')
  const enable = manager.enablePlugin('racy-plugin')
  releaseFirstLoad()

  await Promise.all([disable, enable])
  assert.equal(manager.isEnabled('racy-plugin'), true)
  assert.equal(manager.isLoaded('racy-plugin'), true)
  assert.equal(scripts, 2)
})

test('enable then disable during an in-flight load ends disabled and unloaded', async () => {
  const harness = createHarness([manifest('racy-plugin', {})])
  const { manager } = harness.makeManager()
  await manager.scanAndLoad()
  await manager.disablePlugin('racy-plugin')

  let releaseLoad!: () => void
  let loadStarted!: () => void
  const blockedLoad = new Promise<void>(resolve => { releaseLoad = resolve })
  const scriptAppended = new Promise<void>(resolve => { loadStarted = resolve })
  document.head.appendChild = ((node: Node) => {
    if (node instanceof (window as any).HTMLScriptElement) (node as HTMLScriptElement).removeAttribute('src')
    const result = nativeAppendChild(node)
    loadStarted()
    void blockedLoad.then(() => (node as HTMLScriptElement).onload?.(new Event('load')))
    return result
  }) as typeof document.head.appendChild

  const enable = manager.enablePlugin('racy-plugin')
  await scriptAppended
  const disable = manager.disablePlugin('racy-plugin')
  releaseLoad()

  await Promise.all([enable, disable])
  assert.equal(manager.isEnabled('racy-plugin'), false)
  assert.equal(manager.isLoaded('racy-plugin'), false)
})

test('scan skips plugin folders that have no manifest.json', async () => {
  const harness = createHarness([manifest('wider', { startup: true })], ['trail', 'tree-guides'])
  const { manager } = harness.makeManager()
  await manager.scanAndLoad()
  assert.deepEqual(manager.getManifests().map(item => item.id), ['wider'])
  assert.equal(manager.isLoaded('wider'), true)
})
