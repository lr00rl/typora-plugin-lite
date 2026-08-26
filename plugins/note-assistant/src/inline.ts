/**
 * InlineRenderer: makes `[[target|title]]` anywhere in the document look and
 * behave like a link, not like literal brackets.
 *
 * The hard constraint is that Typora edits a contenteditable DOM, so any
 * decoration that changes the *text* of a block risks changing what gets
 * written back to disk. This renderer therefore never adds, removes, or
 * reorders a single character: it splits the existing text node into spans
 * whose concatenated textContent is byte-identical to the original, and hides
 * the syntax halves with CSS. `[[a/b|Title]]` becomes
 * `[[` + `a/b|` + `Title` + `]]` with the first, second and fourth parts
 * hidden, so the reader sees `Title` while the model still sees the full link.
 *
 * The caret is the other constraint. A decorated block reverts to raw markdown
 * the moment it takes focus, which is how Typora treats its own inline syntax,
 * so editing a link is exactly as it was before. Reprocessing is scoped to the
 * blocks a mutation actually touched plus the block that just gained or lost
 * focus, so typing in a long index page stays cheap.
 */

import { editor } from '@typora-plugin-lite/core'

import type { GraphStore } from './graph.js'
import { WIKI_INLINE_RE } from './wiki-line.js'

/** Global variant; the shared one is non-global so `.match` keeps working. */
const SCAN_RE = new RegExp(WIKI_INLINE_RE.source, 'g')

/**
 * Places a wiki link must never be rewritten: code and math are literal,
 * anchors are already links, and the generated-block machinery owns its own
 * rendering.
 */
const SKIP_SELECTOR = [
  'code',
  'pre',
  '.md-fences',
  '.md-math',
  '.md-comment',
  '.md-raw-inline',
  'a',
  '.tpl-wl',
  '.tpl-note-assistant-inline',
  '.tpl-note-assistant-source',
].join(',')

export class InlineRenderer {
  private writeEl: HTMLElement | null = null
  private observer: MutationObserver | null = null
  private observerConnected = false
  private rafId = 0
  private pending = new Set<HTMLElement>()
  private lastFocus: HTMLElement | null = null
  private currentFile = ''
  private needsFullPass = false
  private clickHandler: ((evt: MouseEvent) => void) | null = null
  /** Surfaced through `note-assistant:state` so the renderer can be proven live. */
  processCount = 0
  linkCount = 0

  constructor(
    private store: GraphStore,
    private notify: (message: string) => void,
  ) {}

  attach(writeEl: HTMLElement): void {
    this.writeEl = writeEl

    this.clickHandler = evt => this.onClick(evt)
    writeEl.addEventListener('click', this.clickHandler, true)

    this.processAll()

    this.observer = new MutationObserver(mutations => {
      let relevant = false
      for (const mutation of mutations) {
        if (this.isOwnMutation(mutation)) continue
        // The target of a top-level insertion is #write itself, which owns no
        // block; the new blocks are only reachable through addedNodes. Reading
        // the target alone meant opening a document decorated nothing at all.
        const block = this.blockOf(mutation.target)
        if (block) {
          this.pending.add(block)
          relevant = true
        }
        for (const node of Array.from(mutation.addedNodes)) {
          const added = this.blockOf(node)
          if (added) {
            this.pending.add(added)
            relevant = true
          }
        }
      }
      const focus = this.focusedBlock()
      if (focus !== this.lastFocus) {
        if (focus) this.pending.add(focus)
        if (this.lastFocus?.isConnected) this.pending.add(this.lastFocus)
        this.lastFocus = focus
        relevant = true
      }
      if (relevant) this.schedule()
    })
    this.connectObserver()
  }

  detach(): void {
    this.disconnectObserver()
    this.observer = null
    cancelAnimationFrame(this.rafId)
    this.pending.clear()
    if (this.writeEl) {
      if (this.clickHandler) this.writeEl.removeEventListener('click', this.clickHandler, true)
      this.undecorate(this.writeEl)
      this.writeEl = null
    }
    this.clickHandler = null
    this.lastFocus = null
    this.linkCount = 0
  }

  /** Full pass; used on attach and after the document is replaced. */
  processAll(): void {
    const root = this.writeEl
    if (!root) return
    this.currentFile = editor.getFilePath()
    this.needsFullPass = false
    this.withObserverPaused(() => {
      this.processCount += 1
      this.lastFocus = this.focusedBlock()
      for (const child of Array.from(root.children)) {
        if (child instanceof HTMLElement) this.processBlock(child)
      }
      this.recount()
    })
  }

  private schedule(): void {
    cancelAnimationFrame(this.rafId)
    this.rafId = requestAnimationFrame(() => this.flush())
  }

  private flush(): void {
    if (!this.writeEl) return
    // Switching notes replaces every block; per-block bookkeeping from the
    // previous document is meaningless, so repaint the whole thing.
    if (this.needsFullPass || editor.getFilePath() !== this.currentFile) {
      this.pending.clear()
      this.processAll()
      return
    }
    const blocks = [...this.pending]
    this.pending.clear()
    if (!blocks.length) return
    this.withObserverPaused(() => {
      this.processCount += 1
      for (const block of blocks) {
        if (block.isConnected) this.processBlock(block)
      }
      this.recount()
    })
  }

  /**
   * Decorate a block, or strip it back to raw text when the caret is inside.
   * Re-decorating is cheap because a block that already carries the stamp and
   * has not changed is skipped by the caller's mutation filter.
   */
  private processBlock(block: HTMLElement): void {
    const focused = block.classList.contains('md-focus') || !!block.querySelector('.md-focus')
    if (focused) {
      this.undecorate(block)
      block.classList.add('tpl-wl-editing')
      return
    }
    block.classList.remove('tpl-wl-editing')
    this.undecorate(block)
    this.decorate(block)
  }

  private decorate(block: HTMLElement): void {
    if (block.closest(SKIP_SELECTOR)) return
    const currentFile = editor.getFilePath()
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Node) => {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT
        return (node.nodeValue || '').includes('[[') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })

    const targets: Text[] = []
    let node = walker.nextNode()
    while (node) {
      targets.push(node as Text)
      node = walker.nextNode()
    }

    for (const textNode of targets) {
      this.replaceInTextNode(textNode, currentFile)
    }
  }

  private replaceInTextNode(textNode: Text, currentFile: string): void {
    const text = textNode.nodeValue || ''
    SCAN_RE.lastIndex = 0
    let match = SCAN_RE.exec(text)
    if (!match) return

    const fragment = document.createDocumentFragment()
    let cursor = 0
    while (match) {
      const [whole, rawTargetRaw, rawTitle] = match
      const rawTarget = (rawTargetRaw || '').trim()
      if (rawTarget) {
        if (match.index > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, match.index)))
        }
        fragment.appendChild(this.buildLink(whole, rawTargetRaw, rawTitle, currentFile))
        cursor = match.index + whole.length
      }
      match = SCAN_RE.exec(text)
    }
    if (!cursor) return
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)))
    textNode.parentNode?.replaceChild(fragment, textNode)
  }

  /**
   * Build the span run for one link. Every character of `whole` ends up in
   * exactly one child, in order, so textContent round-trips unchanged.
   */
  private buildLink(whole: string, rawTarget: string, rawTitle: string | undefined, currentFile: string): HTMLElement {
    const wrapper = document.createElement('span')
    wrapper.className = 'tpl-wl'
    const target = rawTarget.trim()
    wrapper.dataset.tplWlTarget = target
    wrapper.title = target

    const hasTitle = rawTitle !== undefined
    // Without an explicit title the basename is the readable part, so hide the
    // directory prefix rather than inventing text that is not in the document.
    const slash = hasTitle ? -1 : rawTarget.lastIndexOf('/')
    const hiddenLead = hasTitle ? `${rawTarget}|` : rawTarget.slice(0, slash + 1)
    const shown = hasTitle ? (rawTitle as string) : rawTarget.slice(slash + 1)

    wrapper.appendChild(span('tpl-wl-mark', '[['))
    if (hiddenLead) wrapper.appendChild(span('tpl-wl-path', hiddenLead))
    wrapper.appendChild(span('tpl-wl-title', shown))
    wrapper.appendChild(span('tpl-wl-mark', ']]'))

    if (wrapper.textContent !== whole) {
      // Never ship a decoration that would change the document; fall back to
      // the untouched literal instead.
      const literal = document.createElement('span')
      literal.textContent = whole
      return literal
    }

    if (target && currentFile && this.store.isLoaded) {
      if (this.store.probeNoteTarget(target, currentFile) === 'unknown') {
        wrapper.classList.add('tpl-wl-missing')
        wrapper.title = `${target}（索引里找不到，可能已移动或需要重建索引）`
      }
    }
    return wrapper
  }

  private undecorate(scope: HTMLElement): void {
    const links = scope.querySelectorAll<HTMLElement>('.tpl-wl')
    for (const link of Array.from(links)) {
      const parent = link.parentNode
      if (!parent) continue
      parent.replaceChild(document.createTextNode(link.textContent || ''), link)
      if (parent instanceof HTMLElement || parent instanceof DocumentFragment) {
        (parent as Element).normalize?.()
      }
    }
  }

  private onClick(evt: MouseEvent): void {
    const target = evt.target
    if (!(target instanceof HTMLElement)) return
    const link = target.closest('.tpl-wl')
    if (!(link instanceof HTMLElement)) return
    // Alt-click is the escape hatch: put the caret in the text instead of
    // navigating, for when the link itself is what needs editing.
    if (evt.altKey) return
    const rawTarget = link.dataset.tplWlTarget
    if (!rawTarget) return
    evt.preventDefault()
    evt.stopPropagation()
    void this.open(rawTarget)
  }

  private async open(rawTarget: string): Promise<void> {
    const currentFile = editor.getFilePath()
    if (!currentFile) return
    try {
      const hit = await this.store.resolveNoteTarget(rawTarget, currentFile)
      if (!hit.absPath) {
        if (hit.basenameMatches > 1) {
          this.notify(`「${rawTarget}」有 ${hit.basenameMatches} 篇同名笔记，无法确定目标`)
        } else {
          this.notify(`找不到：${rawTarget}。可能已移动或删除；Cmd+Shift+R 重建索引试试`)
        }
        return
      }
      await editor.openFile(hit.absPath)
      if (hit.via === 'basename') {
        this.notify('已按文件名解析到新位置（原路径已失效，重建索引后自愈）')
      }
    } catch (err) {
      console.error('[tpl:note-assistant] inline open failed', err)
      this.notify(`无法打开：${rawTarget}`)
    }
  }

  private recount(): void {
    this.linkCount = this.writeEl?.querySelectorAll('.tpl-wl').length ?? 0
  }

  private focusedBlock(): HTMLElement | null {
    const root = this.writeEl
    if (!root) return null
    const focused = root.querySelector('.md-focus')
    return focused ? this.blockOf(focused) : null
  }

  /** The `#write` child that owns a node, which is the unit we re-render. */
  private blockOf(node: Node | null): HTMLElement | null {
    const root = this.writeEl
    if (!root || !node) return null
    let current: Node | null = node
    while (current && current.parentNode && current.parentNode !== root) {
      current = current.parentNode
    }
    if (!current || current.parentNode !== root) return null
    return current instanceof HTMLElement ? current : null
  }

  private isOwnMutation(mutation: MutationRecord): boolean {
    const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)]
    if (!nodes.length) return false
    return nodes.every(node => {
      if (node instanceof HTMLElement) {
        return node.classList.contains('tpl-wl') || !!node.closest('.tpl-wl')
      }
      return node.parentElement?.closest('.tpl-wl') != null
    })
  }

  private connectObserver(): void {
    if (!this.observer || !this.writeEl || this.observerConnected) return
    this.observer.observe(this.writeEl, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class'],
    })
    this.observerConnected = true
  }

  private disconnectObserver(): void {
    if (!this.observerConnected) return
    this.observer?.disconnect()
    this.observerConnected = false
  }

  private withObserverPaused<T>(fn: () => T): T {
    this.disconnectObserver()
    try {
      return fn()
    } finally {
      this.connectObserver()
    }
  }
}

function span(className: string, text: string): HTMLElement {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}
