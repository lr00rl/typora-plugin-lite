import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

test('Quick Open builds a responsive semantic dialog and restores focus', async () => {
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

  try {
    const { default: QuickOpenPlugin } = await import('../plugins/fuzzy-search/src/main.ts')
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const plugin = new QuickOpenPlugin() as any
    plugin.renderList = async () => {}
    plugin.addDisposable = () => {}
    plugin.buildModal()

    const dialog = document.querySelector<HTMLElement>('#tpl-qo-modal')!
    assert.equal(dialog.getAttribute('role'), 'dialog')
    assert.equal(dialog.getAttribute('aria-modal'), 'true')
    assert.equal(dialog.getAttribute('aria-labelledby'), 'tpl-qo-title')
    assert.equal(document.querySelector('#tpl-qo-input')?.getAttribute('role'), 'combobox')
    assert.equal(document.querySelector('#tpl-qo-input')?.getAttribute('aria-expanded'), 'true')
    assert.equal(document.querySelector('#tpl-qo-input')?.getAttribute('aria-controls'), 'tpl-qo-completions tpl-qo-list')
    assert.equal(document.querySelector('#tpl-qo-tab-bar')?.getAttribute('role'), 'tablist')
    assert.equal(document.querySelectorAll('[role="tab"]').length, 3)
    assert.equal(document.querySelector('#tpl-qo-list')?.getAttribute('role'), 'listbox')
    assert.equal(document.querySelector('#tpl-qo-footer-text')?.getAttribute('aria-live'), 'polite')

    const css = document.querySelector<HTMLStyleElement>('#tpl-qo-style')?.textContent ?? ''
    assert.match(css, /calc\(100vw - 24px\)/)
    assert.match(css, /prefers-reduced-motion: reduce/)
    assert.match(css, /--tpl-ui-surface/)
    assert.match(css, /:focus-visible/)
    const hitRule = css.match(/\.tpl-qo-hit\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(hitRule, /--tpl-ui-accent/)
    assert.match(hitRule, /--tpl-ui-selection/)
    assert.doesNotMatch(hitRule, /255\s*,\s*(?:179|212)/)

    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    tabs[0]!.focus()
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    assert.equal(document.activeElement, tabs[1])
    assert.equal(tabs[0]!.getAttribute('aria-selected'), 'false')
    assert.equal(tabs[0]!.tabIndex, -1)
    assert.equal(tabs[1]!.getAttribute('aria-selected'), 'true')
    assert.equal(tabs[1]!.tabIndex, 0)

    tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    assert.equal(document.activeElement, tabs[2])
    tabs[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    assert.equal(document.activeElement, tabs[0])
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    assert.equal(document.activeElement, tabs[2], 'ArrowLeft wraps to the last tab')

    plugin.close()
    assert.equal(document.activeElement, trigger)
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as any)[name]
    }
    dom.close()
  }
})
