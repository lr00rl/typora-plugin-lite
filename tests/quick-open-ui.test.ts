import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

test('Quick Open builds a responsive semantic dialog and restores focus', async () => {
  const dom = new Window({ url: 'https://localhost/' })
  let resizeCallback: ResizeObserverCallback | null = null
  let resizeTarget: Element | null = null
  let resizeDisconnected = false
  let pendingFrame: FrameRequestCallback | null = null
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback }
    observe(target: Element): void { resizeTarget = target }
    unobserve(): void {}
    disconnect(): void { resizeDisconnected = true }
  }
  Object.defineProperty(dom, 'ResizeObserver', {
    value: TestResizeObserver,
    configurable: true,
  })
  Object.defineProperty(dom, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => { pendingFrame = callback; return 17 },
    configurable: true,
  })
  Object.defineProperty(dom, 'cancelAnimationFrame', {
    value: () => { pendingFrame = null },
    configurable: true,
  })
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
    const renderedQueries: string[] = []
    plugin.renderList = async (query: string) => { renderedQueries.push(query) }
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
    assert.equal(resizeTarget, document.querySelector('#tpl-qo-list'))

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
    assert.match(css, /--tpl-qo-panel-width:\s*740px/)
    assert.match(css, /--tpl-qo-panel-width-wide:\s*1000px/)
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
    assert.match(itemRule, /grid-template-columns:\s*max-content minmax\(0,\s*1fr\)/)
    assert.match(itemRule, /min-height:\s*34px/)
    assert.match(itemRule, /padding:\s*4px 12px 4px 10px/)
    assert.match(itemRule, /gap:\s*10px/)
    assert.match(itemRule, /border-radius:\s*4px/)
    assert.match(itemRule, /box-shadow:\s*none/)

    const nameRule = css.match(/\.tpl-qo-name\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(nameRule, /font-weight:\s*400/)
    assert.match(nameRule, /line-height:\s*1\.25/)
    assert.match(nameRule, /color:\s*var\(--tpl-qo-ink-soft\)/)
    assert.match(nameRule, /overflow:\s*visible/)
    assert.doesNotMatch(nameRule, /max-width/)
    assert.doesNotMatch(nameRule, /text-overflow:\s*ellipsis/)

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

    plugin.setFooter(7000, '/Users/tester/workspace/notes')
    const footerText = document.querySelector<HTMLElement>('#tpl-qo-footer-text')!
    assert.equal(footerText.textContent, '7000 个文件  ·  notes')
    assert.match(footerText.title, /\/Users\/tester\/workspace\/notes/)
    assert.match(footerText.title, /索引:/)

    plugin.updatePlaceholder()
    assert.equal(document.querySelector<HTMLInputElement>('#tpl-qo-input')?.placeholder, '搜索文件…')
    assert.equal(
      plugin.getItemPathText({ relPath: '/Users/tester/workspace/notes/note.md', cwdRelPath: '' }),
      '~/workspace/notes/',
    )

    plugin.currentQuery = 'scope:Projects roadmap'
    plugin.switchTab('folders')
    assert.equal(
      (document.querySelector<HTMLInputElement>('#tpl-qo-input')?.value),
      'type:folder scope:Projects roadmap',
      'the directory tab makes its search type explicit instead of inheriting file search',
    )
    plugin.switchTab('content')
    assert.equal(
      (document.querySelector<HTMLInputElement>('#tpl-qo-input')?.value),
      'type:content scope:Projects roadmap',
    )
    plugin.switchTab('files')
    assert.equal(
      (document.querySelector<HTMLInputElement>('#tpl-qo-input')?.value),
      'type:file scope:Projects roadmap',
    )

    const input = document.querySelector<HTMLInputElement>('#tpl-qo-input')!
    let enteredDirectory = ''
    const originalEnterDir = plugin.enterDir
    plugin.enterDir = (path: string) => { enteredDirectory = path }
    plugin.activeTab = 'folders'
    plugin.rows = [{ kind: 'dir', name: 'Design', path: 'Projects/Design', fileCount: 3 }]
    plugin.selectedIdx = 0
    input.value = 'type:folder scope:Projects/'
    plugin.currentQuery = input.value
    plugin.handleKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    assert.equal(
      enteredDirectory,
      'Projects/Design',
      'tab-owned type/scope tokens do not disable keyboard directory drilling',
    )
    plugin.enterDir = originalEnterDir
    plugin.activeTab = 'files'
    plugin.updateTabBar()

    plugin.switchTab('content')
    renderedQueries.length = 0
    input.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    input.value = 'type:content 中'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 260))
    assert.deepEqual(renderedQueries, [], 'IME composition never starts an incomplete content search')
    input.dispatchEvent(new Event('compositionend', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 440))
    assert.deepEqual(renderedQueries, ['type:content 中'])

    renderedQueries.length = 0
    for (const query of ['type:content q', 'type:content qu', 'type:content quick']) {
      input.value = query
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await new Promise(resolve => setTimeout(resolve, 270))
    assert.deepEqual(renderedQueries, ['type:content quick'], 'rapid input collapses to the latest precise query')
    plugin.switchTab('files')

    const longPath = 'E000_Work/ProjectAtlas/数据平台/项目与资源/Research/TaskGroup_Archive/'
    const fileRow = plugin.makeItem({
      basename: '2026_08_12_revision.md',
      relPath: `${longPath}2026_08_12_revision.md`,
      cwdRelPath: `${longPath}2026_08_12_revision.md`,
    }, 0)
    const filePath = fileRow.querySelector('.tpl-qo-path') as HTMLElement
    assert.equal(filePath.dataset.fullPath, longPath)
    assert.equal(filePath.textContent, longPath)

    const fittedDirectory = 'folder-1/folder-2/folder-3/folder-4/folder-5/folder-6/folder-7/'
    const fittedRow = plugin.makeItem({
      basename: 'note.md',
      relPath: `${fittedDirectory}note.md`,
      cwdRelPath: `${fittedDirectory}note.md`,
    }, 1)
    const fittedPath = fittedRow.querySelector('.tpl-qo-path') as HTMLElement
    document.querySelector('#tpl-qo-list')!.appendChild(fittedRow)
    plugin.cancelQueuedPathFit()
    let availablePathWidth = 'folder-1/folder-2/.../folder-6/folder-7/'.length + 1
    Object.defineProperty(fittedPath, 'clientWidth', {
      configurable: true,
      get: () => availablePathWidth,
    })
    plugin.makePathTextMeasure = () => (value: string) => value.length
    plugin.fitPathLabels()
    assert.equal(fittedPath.textContent, 'folder-1/folder-2/.../folder-6/folder-7/')
    assert.equal(fittedPath.dataset.fullPath, fittedDirectory)
    assert.equal(fittedPath.getAttribute('aria-label'), fittedDirectory)
    assert.equal(fittedPath.title, `${fittedDirectory}note.md`)

    availablePathWidth = 4
    plugin.fitPathLabels()
    assert.equal(fittedPath.textContent, '...', 'the path yields when the filename leaves almost no room')
    assert.equal(fittedRow.querySelector('.tpl-qo-name')?.textContent, 'note.md')

    availablePathWidth = fittedDirectory.length + 1
    plugin.fitPathLabels()
    assert.equal(fittedPath.textContent, fittedDirectory, 'a wider popup restores the full path')

    const hitRule = css.match(/\.tpl-qo-hit\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(hitRule, /--tpl-qo-accent-soft/)
    assert.match(hitRule, /--tpl-qo-selection-soft/)
    assert.doesNotMatch(hitRule, /255\s*,\s*(?:179|212)/)

    plugin.currentQuery = 'type:content alpha beta'
    const contentRow = plugin.makeContentItem({
      absPath: '/vault/Projects/decision.md',
      relPath: 'Projects/decision.md',
      basename: 'decision.md',
      line: 42,
      col: 8,
      matchText: 'The alpha beta decision is recorded here.',
      score: 0.91,
      contextLines: [
        { line: 41, text: 'Context before the decision.', kind: 'before' },
        { line: 42, text: 'The alpha beta decision is recorded here.', kind: 'match' },
        { line: 43, text: 'Context after the decision.', kind: 'after' },
      ],
    }, 0)
    assert.equal(contentRow.classList.contains('tpl-qo-content-item'), true)
    assert.equal(contentRow.querySelector('.tpl-qo-content-name')?.textContent, 'decision.md')
    assert.equal(contentRow.querySelector('.tpl-qo-content-path')?.textContent, 'Projects/')
    assert.equal(contentRow.querySelector('.tpl-qo-content-line-number')?.textContent, 'L42')
    assert.equal(contentRow.querySelectorAll('.tpl-qo-content-context-line').length, 3)
    assert.equal(contentRow.querySelectorAll('.tpl-qo-content-context-match .tpl-qo-hit').length, 2)
    assert.match(contentRow.getAttribute('aria-label') ?? '', /decision\.md.*第 42 行.*91%/)

    const contentItemRule = css.match(/\.tpl-qo-content-item\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(contentItemRule, /display:\s*block/)
    assert.match(contentItemRule, /padding:\s*8px 10px/)
    const contentMetaRule = css.match(/\.tpl-qo-content-meta\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(contentMetaRule, /grid-template-columns:\s*max-content minmax\(0,\s*1fr\) max-content/)
    const contentContextRule = css.match(/\.tpl-qo-content-context\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(contentContextRule, /white-space:\s*pre-wrap/)

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

    let resizeFitRuns = 0
    plugin.fitPathLabels = () => { resizeFitRuns += 1 }
    const observerCallback = resizeCallback as ResizeObserverCallback | null
    assert.ok(observerCallback)
    observerCallback([], {} as ResizeObserver)
    observerCallback([], {} as ResizeObserver)
    const scheduledFit = pendingFrame as FrameRequestCallback | null
    assert.ok(scheduledFit, 'resize queues a path refit in the next animation frame')
    pendingFrame = null
    scheduledFit(0)
    assert.equal(resizeFitRuns, 1, 'multiple resize notifications are coalesced')

    plugin.close()
    assert.equal(document.activeElement, trigger)
    assert.equal(resizeDisconnected, true)
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as any)[name]
    }
    dom.close()
  }
})
