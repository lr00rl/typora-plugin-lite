import test from 'node:test'
import assert from 'node:assert/strict'

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
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  Object.defineProperty(globalThis, 'window', {
    value: {},
    configurable: true,
  })
  Object.defineProperty(globalThis, 'document', {
    value: { getElementById: () => null },
    configurable: true,
  })

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
    },
    hotkeys: {
      register: (key: string, callback: () => void) => {
        hotkeys.push({ key, callback })
      },
    },
    platform: {},
  }

  try {
    plugin.onload()
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
    })
  }

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]?.event, 'command:register')
  assert.equal(emitted[0]?.payload.id, 'sidenote:add')
  assert.equal(emitted[0]?.payload.name, 'Sidenote: Add from Selection')
  assert.equal(emitted[0]?.payload.pluginId, 'sidenote')
  assert.equal(typeof emitted[0]?.payload.callback, 'function')
  assert.equal(hotkeys.length, 1)
  assert.equal(hotkeys[0]?.key, 'Mod+Alt+S')
  assert.equal(typeof hotkeys[0]?.callback, 'function')
})
