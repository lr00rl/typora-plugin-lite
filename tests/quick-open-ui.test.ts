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

    const inputRow = document.querySelector('#tpl-qo-input-row')!
    const tabBar = document.querySelector('#tpl-qo-tab-bar')!
    assert.equal(
      tabBar.parentElement,
      inputRow,
      'search modes belong to the same compact command strip as the input',
    )
    assert.equal(document.querySelector('.tpl-qo-tab-hint'), null, 'shortcut help does not crowd the command strip')
    assert.ok(
      document.querySelector('#tpl-qo-icon svg'),
      'the search affordance uses a crisp vector icon rather than a text glyph',
    )
    const directoryRow = plugin.makeDirItem({ name: 'Projects', fileCount: 12 }, 0)
    assert.equal(directoryRow.textContent?.includes('📁'), false, 'folder rows avoid platform emoji')
    assert.ok(directoryRow.querySelector('.tpl-qo-dir-icon'), 'folder rows keep a quiet authored icon')

    const css = document.querySelector<HTMLStyleElement>('#tpl-qo-style')?.textContent ?? ''
    assert.match(css, /--tpl-qo-panel-width:\s*680px/)
    assert.match(css, /--tpl-qo-panel-width-wide:\s*920px/)
    assert.match(css, /--tpl-qo-ink-soft:/)
    assert.match(css, /--tpl-qo-ink-selected:/)
    assert.match(css, /--tpl-qo-muted:/)
    assert.match(css, /--tpl-qo-selection-soft:/)
    assert.match(css, /--tpl-qo-row-selected:/)
    assert.match(css, /color-mix\(in srgb/)
    assert.match(css, /calc\(100vw - 32px\)/)
    assert.match(css, /max-height:\s*min\(75vh,\s*calc\(100vh - 48px\)\)/)
    assert.match(css, /max-height:\s*min\(75dvh,\s*calc\(100dvh - 48px\)\)/)
    assert.match(css, /prefers-reduced-motion: reduce/)
    assert.match(css, /--tpl-ui-surface/)
    assert.match(css, /:focus-visible/)
    assert.doesNotMatch(css, /rgba\(0\s*,\s*0\s*,\s*0\s*,\s*0\.45\)/)
    assert.doesNotMatch(css, /background:\s*rgba\(22,\s*20,\s*18,\s*0\.28\)/)
    assert.doesNotMatch(css, /#1a73e8/i, 'Quick Open must not fall back to a foreign hard-coded blue')

    const selectedRule = css.match(/\.tpl-qo-item\.tpl-qo-selected\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(selectedRule, /background:\s*var\(--tpl-qo-row-selected\)/)
    assert.match(selectedRule, /box-shadow:\s*none/)
    assert.doesNotMatch(selectedRule, /--tpl-qo-accent-soft/)
    assert.doesNotMatch(selectedRule, /inset/)
    assert.doesNotMatch(
      css,
      /\.tpl-qo-item\.tpl-qo-selected \.tpl-qo-(?:name|content-name)/,
      'selection is communicated by the row surface alone, not darker or heavier text',
    )

    const itemRule = css.match(/\.tpl-qo-item\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(itemRule, /grid-template-columns/)
    assert.match(itemRule, /min-height:\s*34px/)
    assert.match(itemRule, /padding:\s*4px 12px 4px 10px/)
    assert.match(itemRule, /gap:\s*10px/)
    assert.match(itemRule, /border-radius:\s*4px/)
    assert.match(itemRule, /box-shadow:\s*none/)

    const nameRule = css.match(/\.tpl-qo-name\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(nameRule, /font-weight:\s*400/)
    assert.match(nameRule, /line-height:\s*1\.25/)
    assert.match(nameRule, /color:\s*var\(--tpl-qo-ink-soft\)/)

    const contentNameRule = css.match(/\.tpl-qo-content-name\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(contentNameRule, /font-weight:\s*400/)
    assert.match(contentNameRule, /color:\s*var\(--tpl-qo-ink-soft\)/)
    assert.doesNotMatch(css, /font-weight:\s*500/)

    const pathRule = css.match(/\.tpl-qo-path\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(pathRule, /color:\s*var\(--tpl-qo-muted\)/)
    assert.match(pathRule, /line-height:\s*1\.25/)
    assert.match(pathRule, /opacity:\s*1/)

    const listRule = css.match(/#tpl-qo-list\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(listRule, /flex:\s*0 1 auto/)
    assert.match(listRule, /max-height:\s*none/)
    assert.doesNotMatch(css, /max-height:\s*min\(54vh,\s*460px\)/)

    const footerActionRule = css.match(/#tpl-qo-footer-action\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(footerActionRule, /border:\s*0/)
    assert.doesNotMatch(footerActionRule, /border-radius:\s*999px/)

    const inputFocusRule = css.match(/#tpl-qo-input:focus-visible\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(inputFocusRule, /outline:\s*none/)

    plugin.setFooter(7000, '/Users/cdcd/roobli/Nut/RooB')
    const footerText = document.querySelector<HTMLElement>('#tpl-qo-footer-text')!
    assert.equal(footerText.textContent, '7000 个文件  ·  RooB')
    assert.match(footerText.title, /\/Users\/cdcd\/roobli\/Nut\/RooB/)
    assert.match(footerText.title, /索引:/)

    plugin.updatePlaceholder()
    assert.equal(document.querySelector<HTMLInputElement>('#tpl-qo-input')?.placeholder, '搜索文件…')
    assert.equal(
      plugin.getItemPathText({ relPath: '/Users/cdcd/roobli/Nut/RooB/note.md', cwdRelPath: '' }),
      '~/roobli/Nut/RooB',
    )

    const hitRule = css.match(/\.tpl-qo-hit\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(hitRule, /--tpl-qo-accent-soft/)
    assert.match(hitRule, /--tpl-qo-selection-soft/)
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
