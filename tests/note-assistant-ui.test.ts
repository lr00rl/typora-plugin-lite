import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

async function setupDom() {
  const dom = new Window({ url: 'https://localhost/' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const name of ['window', 'document', 'HTMLElement', 'navigator', 'Event', 'KeyboardEvent', 'MouseEvent'] as const) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      value: (dom as any)[name] ?? (dom.document as any)[name],
      configurable: true,
      writable: true,
    })
  }
  return saved
}

async function teardownDom(saved: Map<string, PropertyDescriptor | undefined>) {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  }
}

function keydown(target: Element, init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

const FIXTURE_NOTE = {
  relPath: 'A000/dir/当前笔记.md',
  title: '当前笔记',
  explicitLinks: ['A000/c.md'],
  backlinks: [],
  candidates: [],
  related: [
    { relPath: 'A000/a.md', title: '分布式事务', score: 2, reasons: { sameTopLevel: true, sharedTerms: ['分布式'] } },
    { relPath: 'A000/b.md', title: '算法导论', score: 1, reasons: { explicitLink: true } },
  ],
}

function stubStore() {
  const noteMap = new Map<string, any>([
    ['A000/c.md', { relPath: 'A000/c.md', title: '出链笔记' }],
  ])
  return {
    currentNote: () => ({ currentFile: '/v/A000/dir/当前笔记.md', relPath: FIXTURE_NOTE.relPath, note: FIXTURE_NOTE }),
    noteMap,
    graphRoot: '/v',
    graphPath: '/v/.note-assistant/graph.json',
    generatedAt: '2026-08-22T00:00:00.000Z',
    totalNotes: 3,
    rebuildInFlight: false,
    load: async () => ({}),
    rebuild: async () => true,
  }
}

test('NotePalette builds a semantic, keyboard-driven dialog', async () => {
  const saved = await setupDom()
  try {
    const { NotePalette } = await import('../plugins/note-assistant/src/palette.ts')
    const notices: string[] = []
    const palette = new NotePalette(stubStore() as any, message => notices.push(message))

    await palette.toggle()
    assert.equal(palette.isOpen, true)

    const dialog = document.querySelector<HTMLElement>('#tpl-na-modal')!
    assert.equal(dialog.getAttribute('role'), 'dialog')
    assert.equal(dialog.getAttribute('aria-modal'), 'true')
    assert.equal(dialog.getAttribute('aria-labelledby'), 'tpl-na-title')

    const input = document.querySelector<HTMLInputElement>('#tpl-na-input')!
    assert.equal(input.getAttribute('role'), 'combobox')
    assert.equal(input.getAttribute('aria-haspopup'), 'listbox')
    assert.equal(input.getAttribute('aria-controls'), 'tpl-na-list')

    const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
    assert.deepEqual(tabs.map(tab => tab.textContent), ['相关', '链接', '候选'])
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true')

    assert.equal(document.querySelector('#tpl-na-list')?.getAttribute('role'), 'listbox')
    assert.equal(document.querySelector('#tpl-na-footer-text')?.getAttribute('aria-live'), 'polite')

    // 相关 scope renders graph rows with quiet badges, first row selected.
    let items = Array.from(document.querySelectorAll('.tpl-na-item'))
    assert.equal(items.length, 2)
    assert.equal(items[0].getAttribute('aria-selected'), 'true')
    assert.equal(input.getAttribute('aria-activedescendant'), 'tpl-na-option-0')
    assert.equal(items[1].querySelector('.tpl-na-badge')?.textContent, '链接')

    // Arrow keys move selection without moving focus.
    keydown(input, { key: 'ArrowDown' })
    assert.equal(input.getAttribute('aria-activedescendant'), 'tpl-na-option-1')

    // Tab cycles scopes and re-derives rows deterministically.
    keydown(input, { key: 'Tab' })
    items = Array.from(document.querySelectorAll('.tpl-na-item'))
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true')
    assert.equal(items.length, 1)
    assert.equal(items[0].querySelector('.tpl-na-badge')?.textContent, '出链')
    assert.equal(items[0].querySelector('.tpl-na-name')?.textContent, '出链笔记')

    // Back to 相关; typing a CJK query filters and highlights quietly.
    keydown(input, { key: 'Tab' })
    keydown(input, { key: 'Tab' })
    input.value = '分布'
    input.dispatchEvent(new Event('input'))
    items = Array.from(document.querySelectorAll('.tpl-na-item'))
    assert.equal(items.length, 1)
    assert.ok(items[0].querySelector('.tpl-na-hit'), 'matched runs get the quiet underline mark')

    input.value = 'zzz'
    input.dispatchEvent(new Event('input'))
    assert.equal(document.querySelectorAll('.tpl-na-item').length, 0)
    assert.match(document.querySelector('.tpl-na-status')?.textContent ?? '', /无匹配/)

    keydown(input, { key: 'Escape' })
    assert.equal(palette.isOpen, false)
    assert.equal(document.querySelector('#tpl-na-overlay'), null)
  } finally {
    await teardownDom(saved)
  }
})

test('palette CSS keeps the house contract and bans the old sins', async () => {
  const { CSS } = await import('../plugins/note-assistant/src/styles.ts')
  assert.match(CSS, /width:\s*min\(740px, calc\(100vw - 32px\)\)/)
  assert.match(CSS, /max-height:\s*min\(75vh/)
  assert.match(CSS, /min-height:\s*34px/)
  assert.match(CSS, /color-mix\(in srgb/)
  assert.match(CSS, /--tpl-ui-/)
  assert.match(CSS, /@media \(hover: hover\) and \(pointer: fine\)/)
  assert.match(CSS, /prefers-reduced-motion/)
  assert.doesNotMatch(CSS, /linear-gradient/)
  assert.doesNotMatch(CSS, /backdrop-filter/)
  assert.doesNotMatch(CSS, /#4f7dff|#3e68e9/i)
})
