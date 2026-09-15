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
  for (const name of ['window', 'document', 'HTMLElement', 'MutationObserver', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'Event', 'MouseEvent', 'DocumentFragment'] as const) {
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

function makeWrite(): HTMLElement {
  const write = document.createElement('div')
  write.id = 'write'
  document.body.appendChild(write)
  return write
}

function stubStore(overrides: Record<string, unknown> = {}) {
  return {
    isLoaded: false,
    rootDir: () => '/v',
    probeNoteTarget: () => 'known',
    resolveNoteTarget: async () => ({ absPath: null, via: null, basenameMatches: 0 }),
    ...overrides,
  }
}

test('inline links render a title while the document text stays byte-identical', async () => {
  const { saved } = await setupDom()
  try {
    const { InlineRenderer } = await import('../plugins/note-assistant/src/inline.ts')
    const write = makeWrite()
    const source = '对照我这边已有的 [[ACP|ACP]] 笔记，位置又不一样。'
    write.innerHTML = `<p cid="p1">${source}</p>`

    const renderer = new InlineRenderer(stubStore() as any, () => {})
    renderer.attach(write)

    const paragraph = write.querySelector('p')!
    // The whole point: never change a character of the document.
    assert.equal(paragraph.textContent, source, 'text content round-trips unchanged')

    const link = write.querySelector('.tpl-wl')!
    assert.equal(link.getAttribute('data-tpl-wl-target'), 'ACP')
    assert.equal(link.querySelector('.tpl-wl-title')?.textContent, 'ACP')
    assert.equal(link.querySelector('.tpl-wl-path')?.textContent, 'ACP|')
    assert.deepEqual(
      [...link.querySelectorAll('.tpl-wl-mark')].map(el => el.textContent),
      ['[[', ']]'],
    )
    assert.equal(renderer.linkCount, 1)

    renderer.detach()
    assert.equal(write.querySelector('.tpl-wl'), null, 'detach restores plain text')
    assert.equal(write.querySelector('p')!.textContent, source)
  } finally {
    await teardownDom(saved)
  }
})

test('a title-less link shows its basename by hiding only the directory prefix', async () => {
  const { saved } = await setupDom()
  try {
    const { InlineRenderer } = await import('../plugins/note-assistant/src/inline.ts')
    const write = makeWrite()
    const source = '见 [[../A402_VPN_Proxy/proxy_detection]] 一篇。'
    write.innerHTML = `<p cid="p1">${source}</p>`

    const renderer = new InlineRenderer(stubStore() as any, () => {})
    renderer.attach(write)

    assert.equal(write.querySelector('p')!.textContent, source)
    const link = write.querySelector('.tpl-wl')!
    assert.equal(link.querySelector('.tpl-wl-title')?.textContent, 'proxy_detection')
    assert.equal(link.querySelector('.tpl-wl-path')?.textContent, '../A402_VPN_Proxy/')
    renderer.detach()
  } finally {
    await teardownDom(saved)
  }
})

test('code, math and generated blocks are left alone', async () => {
  const { saved } = await setupDom()
  try {
    const { InlineRenderer } = await import('../plugins/note-assistant/src/inline.ts')
    const write = makeWrite()
    write.innerHTML = `
      <p cid="p1">行内 <code>[[not/a/link]]</code> 保持原样</p>
      <pre cid="p2" class="md-fences">[[also/not|A]]</pre>
      <div cid="p3" class="tpl-note-assistant-source">[[generated/block|B]]</div>
      <p cid="p4">但这个 [[real/one|真链接]] 要渲染</p>
    `
    const renderer = new InlineRenderer(stubStore() as any, () => {})
    renderer.attach(write)

    assert.equal(write.querySelectorAll('.tpl-wl').length, 1)
    assert.equal(write.querySelector('.tpl-wl')?.getAttribute('data-tpl-wl-target'), 'real/one')
    renderer.detach()
  } finally {
    await teardownDom(saved)
  }
})

test('the block holding the caret falls back to raw markdown', async () => {
  const { saved } = await setupDom()
  try {
    const { InlineRenderer } = await import('../plugins/note-assistant/src/inline.ts')
    const write = makeWrite()
    const source = '编辑中的 [[a/b|标题]] 行'
    write.innerHTML = `<p cid="p1" class="md-focus">${source}</p><p cid="p2">别处的 [[c/d|另一个]]</p>`

    const renderer = new InlineRenderer(stubStore() as any, () => {})
    renderer.attach(write)

    const focused = write.querySelector('[cid="p1"]')!
    assert.equal(focused.querySelector('.tpl-wl'), null, 'focused block shows raw syntax')
    assert.equal(focused.textContent, source)
    assert.equal(write.querySelector('[cid="p2"]')!.querySelectorAll('.tpl-wl').length, 1)
    renderer.detach()
  } finally {
    await teardownDom(saved)
  }
})

test('a target missing from the index is marked instead of looking live', async () => {
  const { saved } = await setupDom()
  try {
    const { InlineRenderer } = await import('../plugins/note-assistant/src/inline.ts')
    const write = makeWrite()
    write.innerHTML = `<p cid="p1">[[gone/away|走了]]</p>`

    // The probe only runs with a real current file, since every candidate path
    // is resolved relative to it.
    ;(globalThis as any).window.File = { filePath: '/v/notes/here.md' }

    const store = stubStore({ isLoaded: true, probeNoteTarget: () => 'unknown' })
    const renderer = new InlineRenderer(store as any, () => {})
    renderer.attach(write)

    const link = write.querySelector('.tpl-wl')!
    assert.equal(link.classList.contains('tpl-wl-missing'), true)
    renderer.detach()
  } finally {
    await teardownDom(saved)
  }
})

test('multiple links in one paragraph all render and preserve the text', async () => {
  const { saved } = await setupDom()
  try {
    const { InlineRenderer } = await import('../plugins/note-assistant/src/inline.ts')
    const write = makeWrite()
    const source = '从 [[a/one|甲]] 到 [[b/two|乙]] 再到 [[c/three]] 结束'
    write.innerHTML = `<p cid="p1">${source}</p>`

    const renderer = new InlineRenderer(stubStore() as any, () => {})
    renderer.attach(write)

    assert.equal(write.querySelectorAll('.tpl-wl').length, 3)
    assert.equal(write.querySelector('p')!.textContent, source)
    renderer.detach()
    assert.equal(write.querySelector('p')!.textContent, source)
  } finally {
    await teardownDom(saved)
  }
})

test('a document that arrives after attach still gets decorated', async () => {
  const { saved, flushFrame } = await setupDom()
  try {
    const { InlineRenderer } = await import('../plugins/note-assistant/src/inline.ts')
    const write = makeWrite()
    // Typora loads the plugin before it renders the file, so #write is empty
    // at attach time and every block arrives as an addedNode of #write itself.
    const renderer = new InlineRenderer(stubStore() as any, () => {})
    renderer.attach(write)
    assert.equal(renderer.linkCount, 0)

    const paragraph = document.createElement('p')
    paragraph.setAttribute('cid', 'p1')
    paragraph.textContent = '相关笔记：[[Harness/TheAnatomyofanAgentHarness|Harness 的解剖]]。'
    write.appendChild(paragraph)

    await new Promise(resolve => setTimeout(resolve, 10))
    flushFrame()

    assert.equal(write.querySelectorAll('.tpl-wl').length, 1, 'blocks added after attach are decorated')
    assert.equal(
      write.querySelector('.tpl-wl-title')?.textContent,
      'Harness 的解剖',
    )
    renderer.detach()
  } finally {
    await teardownDom(saved)
  }
})

test('switching notes repaints instead of reusing the old document state', async () => {
  const { saved, flushFrame } = await setupDom()
  try {
    const { InlineRenderer } = await import('../plugins/note-assistant/src/inline.ts')
    const write = makeWrite()
    ;(globalThis as any).window.File = { filePath: '/v/first.md' }
    write.innerHTML = `<p cid="p1">第一篇 [[a/one|甲]]</p>`

    const renderer = new InlineRenderer(stubStore() as any, () => {})
    renderer.attach(write)
    assert.equal(renderer.linkCount, 1)

    ;(globalThis as any).window.File = { filePath: '/v/second.md' }
    write.innerHTML = `<p cid="p2">第二篇 [[b/two|乙]] 和 [[c/three|丙]]</p>`

    await new Promise(resolve => setTimeout(resolve, 10))
    flushFrame()

    assert.equal(renderer.linkCount, 2, 'the new document is decorated')
    assert.equal(write.querySelector('.tpl-wl-title')?.textContent, '乙')
    renderer.detach()
  } finally {
    await teardownDom(saved)
  }
})

/** Live Typora HTML: one `_…_` pair swallowed two dated wiki-links. */
const TYPORA_EMPHASIS_HTML = '<span md-inline="plain" class="md-plain">关联：[[unlock联系方式统筹]]（供应商能力与实测）、[[Done_2026_08_31</span><span md-inline="em" class="md-pair-s"><span class="md-meta md-before">_</span><em><span md-inline="plain" class="md-plain">对齐模型后端所有解锁的接口]]（招聘端现在怎么调）、[[2026_08_28</span></em><span class="md-meta md-after">_</span></span><span md-inline="plain" class="md-plain">补充people-unlock]]（mira-api 隐藏路由）。</span>'

test('flattening Typora emphasis DOM recovers the original wiki-link source', async () => {
  const { saved } = await setupDom()
  try {
    const { flattenMarkdownText, wikiMatchesIn, matchCrossesTextNodes } = await import('../plugins/note-assistant/src/wiki-dom.ts')
    const write = makeWrite()
    const paragraph = document.createElement('p')
    paragraph.innerHTML = TYPORA_EMPHASIS_HTML
    write.appendChild(paragraph)

    const { text, map } = flattenMarkdownText(paragraph, 'code, pre, .tpl-wl')
    assert.equal(
      text,
      '关联：[[unlock联系方式统筹]]（供应商能力与实测）、[[Done_2026_08_31_对齐模型后端所有解锁的接口]]（招聘端现在怎么调）、[[2026_08_28_补充people-unlock]]（mira-api 隐藏路由）。',
    )
    const matches = wikiMatchesIn(text)
    assert.deepEqual(matches.map(item => item.target), [
      'unlock联系方式统筹',
      'Done_2026_08_31_对齐模型后端所有解锁的接口',
      '2026_08_28_补充people-unlock',
    ])
    assert.equal(matchCrossesTextNodes(map, matches[0]!), false)
    assert.equal(matchCrossesTextNodes(map, matches[1]!), true)
    assert.equal(matchCrossesTextNodes(map, matches[2]!), true)
  } finally {
    await teardownDom(saved)
  }
})

test('wiki-links split by Typora _italic_ still decorate and keep textContent', async () => {
  const { saved } = await setupDom()
  try {
    const { InlineRenderer } = await import('../plugins/note-assistant/src/inline.ts')
    const write = makeWrite()
    const paragraph = document.createElement('p')
    paragraph.setAttribute('cid', 'p1')
    paragraph.innerHTML = TYPORA_EMPHASIS_HTML
    const original = paragraph.textContent
    write.appendChild(paragraph)

    const renderer = new InlineRenderer(stubStore() as any, () => {})
    renderer.attach(write)

    assert.equal(paragraph.textContent, original, 'emphasis wrap must not add or drop characters')
    const links = [...write.querySelectorAll<HTMLElement>('.tpl-wl')]
    assert.equal(links.length, 3)
    assert.deepEqual(
      links.map(link => link.dataset.tplWlTarget),
      [
        'unlock联系方式统筹',
        'Done_2026_08_31_对齐模型后端所有解锁的接口',
        '2026_08_28_补充people-unlock',
      ],
    )
    assert.equal(write.querySelectorAll('.tpl-wl-across').length, 2)
    assert.equal(
      write.querySelector('.tpl-wl-across')?.getAttribute('data-tpl-wl-label'),
      'Done_2026_08_31_对齐模型后端所有解锁的接口',
    )

    renderer.detach()
    assert.equal(write.querySelector('.tpl-wl'), null)
    assert.equal(paragraph.textContent, original)
  } finally {
    await teardownDom(saved)
  }
})
