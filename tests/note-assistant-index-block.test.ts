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

/** The shape `node tools/vault.mjs index` actually writes into a 00_索引.md. */
const INDEX_HTML = `
  <div cid="n1"><span class="md-comment">&lt;!-- note-assistant:index:start --&gt;</span></div>
  <h2 cid="n2">目录索引</h2>
  <p cid="n3">自动生成，勿手改。</p>
  <h3 cid="n4">子目录</h3>
  <ul cid="n5">
    <li cid="n5a">firewall（2 篇）
      <ul>
        <li>[[firewall/iptables|iptables 与 netfilter]]</li>
        <li>[[firewall/nftables|nftables]]</li>
      </ul>
    </li>
    <li cid="n5b">[[ssh/00_索引|ssh]]（6 篇）</li>
  </ul>
  <h3 cid="n6">笔记</h3>
  <ul cid="n7">
    <li cid="n7a">[[sysctl_bbr_tuning|BBR + fq 与 TCP 栈调优]]</li>
  </ul>
  <div cid="n8"><span class="md-comment">&lt;!-- note-assistant:index:end --&gt;</span></div>
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

test('BlockRenderer renders the index marker family the vault actually writes', async () => {
  const { saved } = await setupDom()
  try {
    const { BlockRenderer } = await import('../plugins/note-assistant/src/block.ts')
    const write = makeWrite()
    write.innerHTML = INDEX_HTML

    const renderer = new BlockRenderer(stubStore() as any, () => {}, () => {})
    renderer.attach(write)

    assert.equal(renderer.renderedCount, 1, 'note-assistant:index:* is recognised')
    const panel = write.querySelector('.tpl-note-assistant-inline')!
    assert.equal(panel.querySelector('.tpl-note-assistant-inline-title')?.textContent, '目录索引')

    // Both sections survive: the old parser only ever read the first list.
    const sections = [...panel.querySelectorAll('.tpl-note-assistant-inline-section')]
      .map(el => el.textContent)
    assert.deepEqual(sections, ['子目录', '笔记'])

    // 4 links: two nested under the label, one label-less link, one note.
    assert.equal(panel.querySelector('.tpl-note-assistant-inline-count')?.textContent, '4 条')
    const titles = [...panel.querySelectorAll('.tpl-note-assistant-inline-item-title')].map(el => el.textContent)
    assert.deepEqual(titles, ['iptables 与 netfilter', 'nftables', 'ssh', 'BBR + fq 与 TCP 栈调优'])

    // A plain line keeps its place as a label rather than vanishing.
    const label = panel.querySelector('.tpl-note-assistant-inline-label')
    assert.equal(label?.textContent, 'firewall（2 篇）')

    // A count trailing the link is kept and not mistaken for the path.
    const sshPath = [...panel.querySelectorAll('.tpl-note-assistant-inline-item')]
      .find(el => el.querySelector('.tpl-note-assistant-inline-item-title')?.textContent === 'ssh')
      ?.querySelector('.tpl-note-assistant-inline-item-path')?.textContent
    assert.equal(sshPath, '（6 篇）')

    renderer.detach()
  } finally {
    await teardownDom(saved)
  }
})

test('BlockRenderer still renders the legacy marker family', async () => {
  const { saved } = await setupDom()
  try {
    const { BlockRenderer } = await import('../plugins/note-assistant/src/block.ts')
    const write = makeWrite()
    write.innerHTML = `
      <div cid="b1"><span class="md-comment">&lt;!-- note-assistant:start --&gt;</span></div>
      <h2 cid="b2">相关笔记</h2>
      <ul cid="b3"><li>[[a/raft|Raft]] - 共词·分布式</li></ul>
      <div cid="b4"><span class="md-comment">&lt;!-- note-assistant:end --&gt;</span></div>
    `
    const renderer = new BlockRenderer(stubStore() as any, () => {}, () => {})
    renderer.attach(write)
    assert.equal(renderer.renderedCount, 1)
    const panel = write.querySelector('.tpl-note-assistant-inline')!
    assert.equal(panel.querySelector('.tpl-note-assistant-inline-title')?.textContent, '相关笔记')
    assert.equal(panel.querySelector('.tpl-note-assistant-inline-item-path')?.textContent, '共词·分布式')
    renderer.detach()
  } finally {
    await teardownDom(saved)
  }
})
