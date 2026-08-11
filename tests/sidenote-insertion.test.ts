import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

import { formatSidenoteInsertion } from '../plugins/sidenote/src/insertion.ts'

test('wraps selected text as a sidenote span', () => {
  assert.equal(
    formatSidenoteInsertion('important context'),
    '<span class="sidenote">important context</span>',
  )
})

test('escapes HTML-sensitive characters in selected text', () => {
  assert.equal(
    formatSidenoteInsertion('A < B & C > D'),
    '<span class="sidenote">A &lt; B &amp; C &gt; D</span>',
  )
})

test('normalizes multiline selected text for inline HTML', () => {
  assert.equal(
    formatSidenoteInsertion(' first line \n\n second line\twith space '),
    '<span class="sidenote">first line second line with space</span>',
  )
})

test('creates an empty sidenote span when there is no selection', () => {
  assert.equal(
    formatSidenoteInsertion(''),
    '<span class="sidenote"></span>',
  )
})

test('registers add command even when the write element is not ready', async () => {
  const dom = new Window()
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const name of [
    'window', 'document', 'Node', 'HTMLElement', 'MutationObserver', 'ResizeObserver',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ]) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    const value = name === 'window'
      ? dom
      : name === 'document'
        ? dom.document
        : (dom as any)[name]
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }

  const { default: SidenotePlugin } = await import('../plugins/sidenote/src/main.ts')
  const emitted: Array<{ event: string, payload: any }> = []
  const hotkeys: Array<{ key: string, callback: () => void }> = []
  const plugin = new SidenotePlugin()
  ;(plugin as any).manifest = { id: 'sidenote' }
  ;(plugin as any).app = {
    events: {
      emit: (event: string, payload: any) => {
        emitted.push({ event, payload })
      },
      on: () => {},
      off: () => {},
    },
    hotkeys: {
      register: (key: string, callback: () => void) => {
        hotkeys.push({ key, callback })
      },
      unregister: () => {},
    },
    platform: {},
  }

  try {
    plugin.onload()
  } finally {
    plugin._destroy()
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as Record<string, unknown>)[name]
    }
    dom.close()
  }

  const registration = emitted.find(item => item.event === 'command:register')
  assert.ok(registration)
  assert.equal(registration.payload.id, 'sidenote:add')
  assert.equal(registration.payload.name, 'Sidenote: Add from Selection')
  assert.equal(registration.payload.pluginId, 'sidenote')
  assert.equal(typeof registration.payload.callback, 'function')
  assert.equal(hotkeys.length, 1)
  assert.equal(hotkeys[0]?.key, 'Mod+Alt+S')
  assert.equal(typeof hotkeys[0]?.callback, 'function')
})
