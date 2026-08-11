import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

function installDom() {
  const dom = new Window({ url: 'https://typora.local/' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const name of [
    'window',
    'document',
    'Node',
    'HTMLElement',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    const value = name === 'window'
      ? dom
      : name === 'document'
        ? dom.document
        : (dom as any)[name]
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  return {
    dom,
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete (globalThis as Record<string, unknown>)[name]
      }
      dom.close()
    },
  }
}

function appendWritingArea(dom: Window, hostWidth: number, text: string): HTMLElement {
  const host = dom.document.createElement('main')
  Object.defineProperty(host, 'clientWidth', { value: hostWidth, configurable: true })
  host.getBoundingClientRect = (() => ({
    x: 0, y: 0, top: 0, left: 0, right: hostWidth, bottom: 800,
    width: hostWidth, height: 800, toJSON: () => ({}),
  })) as any

  const write = dom.document.createElement('div')
  write.id = 'write'
  write.innerHTML = `<p><span class="md-html-inline"><span class="md-meta md-before">&lt;span class="sidenote"&gt;</span>${text}<span class="md-meta md-after">&lt;/span&gt;</span></span></p>`
  write.getBoundingClientRect = (() => ({
    x: 100, y: 0, top: 0, left: 100, right: 960, bottom: 800,
    width: 860, height: 800, toJSON: () => ({}),
  })) as any
  host.appendChild(write)
  dom.document.body.appendChild(host)
  return write as unknown as HTMLElement
}

function makePlugin(SidenotePlugin: any) {
  const plugin = new SidenotePlugin()
  plugin.manifest = { id: 'sidenote' }
  plugin.app = {
    events: { emit() {}, on() {}, off() {} },
    hotkeys: { register() {}, unregister() {} },
    platform: {},
  }
  return plugin
}

test('margin and inline modes expose exactly one accessible sidenote representation', async () => {
  const env = installDom()
  const write = appendWritingArea(env.dom, 1400, 'Margin note')
  const { default: SidenotePlugin } = await import('../plugins/sidenote/src/main.ts')
  const plugin = makePlugin(SidenotePlugin)

  try {
    plugin.onload()
    const source = write.querySelector<HTMLElement>('.tpl-sidenote')!
    const marker = write.querySelector<HTMLElement>('.tpl-sn-num')!
    const portal = env.dom.document.querySelector('.tpl-sidenote-portal') as unknown as HTMLElement
    const layer = env.dom.document.getElementById('tpl-sidenote-portal-layer')!

    assert.equal(layer.hasAttribute('aria-hidden'), false)
    assert.equal(portal.getAttribute('role'), 'note')
    assert.equal(portal.getAttribute('aria-label'), 'Sidenote 1')
    assert.match(portal.id, /^tpl-sidenote-note-/)
    assert.equal(marker.getAttribute('aria-describedby'), portal.id)
    assert.equal(source.getAttribute('aria-hidden'), 'true')

    source.closest('p')!.classList.add('md-focus')
    ;(plugin as any).processAll(write)
    assert.equal(env.dom.document.querySelector('.tpl-sidenote-portal'), null)
    assert.equal(write.querySelector('.tpl-sn-num'), null)
    assert.equal(source.hasAttribute('aria-hidden'), false)
    source.closest('p')!.classList.remove('md-focus')
    ;(plugin as any).processAll(write)

    Object.defineProperty(write.parentElement!, 'clientWidth', { value: 900, configurable: true })
    write.parentElement!.getBoundingClientRect = (() => ({
      x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 800,
      width: 900, height: 800, toJSON: () => ({}),
    })) as any
    ;(plugin as any).processAll(write)

    const inlineMarker = write.querySelector<HTMLElement>('.tpl-sn-num')!
    assert.equal(env.dom.document.querySelector('.tpl-sidenote-portal'), null)
    assert.equal(inlineMarker.hasAttribute('aria-describedby'), false)
    assert.equal(source.hasAttribute('aria-hidden'), false)
  } finally {
    plugin._destroy()
    env.restore()
  }
})

test('rebinding after a file switch cleans the old write and processes the replacement', async () => {
  const env = installDom()
  const oldWrite = appendWritingArea(env.dom, 1400, 'Old note')
  const { default: SidenotePlugin } = await import('../plugins/sidenote/src/main.ts')
  const plugin = makePlugin(SidenotePlugin)

  try {
    plugin.onload()
    const oldSource = oldWrite.querySelector<HTMLElement>('.tpl-sidenote')!
    assert.equal(oldSource.getAttribute('aria-hidden'), 'true')

    const oldHost = oldWrite.parentElement!
    const newWrite = appendWritingArea(env.dom, 1400, 'New note')
    oldHost.remove()
    ;(plugin as any).refreshWritingArea()

    assert.equal((plugin as any).writeEl, newWrite)
    assert.equal(oldWrite.classList.contains('tpl-has-sidenotes'), false)
    assert.equal(oldWrite.querySelector('.tpl-sn-num'), null)
    assert.equal(oldSource.classList.contains('tpl-sidenote'), false)
    assert.equal(oldSource.hasAttribute('aria-hidden'), false)
    assert.ok(newWrite.querySelector('.tpl-sn-num'))
    assert.ok(env.dom.document.querySelector('.tpl-sidenote-portal'))
  } finally {
    plugin._destroy()
    env.restore()
  }
})
