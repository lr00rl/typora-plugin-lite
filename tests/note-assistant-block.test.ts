import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

async function setupDom() {
  const dom = new Window({ url: 'https://localhost/' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  let pendingFrame: FrameRequestCallback | null = null
  Object.defineProperty(dom, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => { pendingFrame = callback; return 17 },
    configurable: true,
  })
  Object.defineProperty(dom, 'cancelAnimationFrame', {
    value: () => { pendingFrame = null },
    configurable: true,
  })
  for (const name of ['window', 'document', 'HTMLElement', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'Event'] as const) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      value: (dom as any)[name] ?? (dom.document as any)[name],
      configurable: true,
      writable: true,
    })
  }
  return {
    saved,
    flushFrame() {
      const callback = pendingFrame
      pendingFrame = null
      callback?.(0)
    },
  }
}

async function teardownDom(saved: Map<string, PropertyDescriptor | undefined>) {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  }
}

const BLOCK_HTML = `
  <div cid="b1"><span class="md-comment">&lt;!-- note-assistant:start --&gt;</span></div>
  <h2 cid="b2">相关笔记</h2>
  <ul cid="b3">
    <li cid="b3a">[[a/raft|Raft]] - 共词·分布式</li>
    <li cid="b3b">[[a/paxos|Paxos]]</li>
  </ul>
  <div cid="b4"><span class="md-comment">&lt;!-- note-assistant:end --&gt;</span></div>
`

function makeWrite(): HTMLElement {
  const write = document.createElement('div')
  write.id = 'write'
  document.body.appendChild(write)
  return write
}

function stubStore() {
  return { rootDir: () => '/v', resolveNoteTarget: async () => ({ absPath: null, via: null, basenameMatches: 0 }) }
}

test('BlockRenderer renders a quiet read-only list and hides the source', async () => {
  const { saved, flushFrame } = await setupDom()
  try {
    const { BlockRenderer } = await import('../plugins/note-assistant/src/block.ts')
    const write = makeWrite()
    write.innerHTML = BLOCK_HTML

    const renderer = new BlockRenderer(stubStore() as any, () => {}, () => {})
    renderer.attach(write)

    assert.equal(renderer.processCount, 1, 'attach processes once')
    assert.equal(renderer.renderedCount, 1)
    assert.equal(write.classList.contains('tpl-has-note-assistant-block'), true)
    assert.equal(write.querySelectorAll('.tpl-note-assistant-source-hidden').length, 4)

    const panel = write.querySelector('.tpl-note-assistant-inline')!
    assert.equal(panel.getAttribute('contenteditable'), 'false')
    assert.equal(panel.querySelector('.tpl-note-assistant-inline-title')?.textContent, '相关笔记')
    assert.equal(panel.querySelector('.tpl-note-assistant-inline-count')?.textContent, '2 条')
    const items = panel.querySelectorAll('.tpl-note-assistant-inline-item')
    assert.equal(items.length, 2)
    assert.equal(items[0].querySelector('.tpl-note-assistant-inline-item-title')?.textContent, 'Raft')
    assert.equal(items[1].querySelector('.tpl-note-assistant-inline-item-path')?.textContent, 'a/paxos')

    renderer.detach()
    assert.equal(write.querySelector('.tpl-note-assistant-inline'), null)
    assert.equal(write.querySelectorAll('.tpl-note-assistant-source-hidden').length, 0)
  } finally {
    await teardownDom(saved)
  }
})

test('BlockRenderer ignores irrelevant mutations and reprocesses block edits', async () => {
  const { saved, flushFrame } = await setupDom()
  try {
    const { BlockRenderer } = await import('../plugins/note-assistant/src/block.ts')
    const write = makeWrite()
    write.innerHTML = BLOCK_HTML

    const renderer = new BlockRenderer(stubStore() as any, () => {}, () => {})
    renderer.attach(write)
    assert.equal(renderer.processCount, 1)

    // Typing elsewhere in the document: a new paragraph appears, nothing else.
    const paragraph = document.createElement('p')
    paragraph.textContent = '在别处打字'
    write.appendChild(paragraph)
    await new Promise(resolve => setTimeout(resolve, 10))
    flushFrame()
    assert.equal(renderer.processCount, 1, 'unrelated typing costs zero reprocessing')

    // Removing the end comment dissolves the block: sources become visible again.
    write.querySelector('[cid="b4"]')!.remove()
    await new Promise(resolve => setTimeout(resolve, 10))
    flushFrame()
    assert.equal(renderer.processCount, 2, 'a comment removal is relevant')
    assert.equal(renderer.renderedCount, 0)
    assert.equal(write.querySelector('.tpl-note-assistant-inline'), null)
    assert.equal(write.querySelectorAll('.tpl-note-assistant-source-hidden').length, 0)

    renderer.detach()
  } finally {
    await teardownDom(saved)
  }
})
