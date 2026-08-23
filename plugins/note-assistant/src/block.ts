/**
 * BlockRenderer: turns `<!-- note-assistant:start/end -->` regions of the live
 * document into a quiet, read-only link list.
 *
 * The block is generated output owned by the vault pipeline (apply-graph
 * rewrites it; build-graph strips it before analysis), so the renderer offers
 * exactly two actions: click a link to open it, or open the palette. Editing
 * the block is just editing markdown — Typora re-renders, the observer
 * re-parses.
 *
 * The observer filter is the point: typing anywhere outside a block costs zero
 * work. A mutation is relevant only when it adds/removes comment nodes (a block
 * appeared or disappeared) or lands inside an already-stamped block region.
 */

import { editor, platform } from '@typora-plugin-lite/core'

import type { GraphStore } from './graph.js'
import { targetCandidates } from './links.js'
import { parseWikiLine } from './wiki-line.js'

const BLOCK_START = '<!-- note-assistant:start -->'
const BLOCK_END = '<!-- note-assistant:end -->'

interface InlineItem {
  rawTarget: string
  displayTitle: string
}

interface InlineBlock {
  title: string
  items: InlineItem[]
}

export class BlockRenderer {
  private writeEl: HTMLElement | null = null
  private observer: MutationObserver | null = null
  private observerConnected = false
  private rafId = 0
  /** Counters surfaced through `note-assistant:state` to prove the filter works. */
  processCount = 0
  renderedCount = 0

  constructor(
    private store: GraphStore,
    private openPalette: () => void,
  ) {}

  attach(writeEl: HTMLElement): void {
    this.writeEl = writeEl
    this.process()
    this.observer = new MutationObserver(mutations => {
      if (!this.isRelevant(mutations)) return
      this.schedule()
    })
    this.connectObserver()
  }

  detach(): void {
    this.disconnectObserver()
    this.observer = null
    cancelAnimationFrame(this.rafId)
    if (this.writeEl) {
      this.clear(this.writeEl)
      this.writeEl.classList.remove('tpl-has-note-assistant-block')
      this.writeEl = null
    }
  }

  private schedule(): void {
    cancelAnimationFrame(this.rafId)
    this.rafId = requestAnimationFrame(() => this.process())
  }

  private isRelevant(mutations: MutationRecord[]): boolean {
    for (const mutation of mutations) {
      const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)]
      const ownOnly = nodes.length > 0 && nodes.every(node => this.isOwnNode(node))
      if (ownOnly) continue

      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue
        if (node.classList.contains('md-comment') || node.querySelector('.md-comment')) return true
        // A stamped block region went away without its comments being touched
        // (model-level deletion of hidden content).
        if (node.dataset?.tplNoteKey || node.querySelector('[data-tpl-note-key]')) return true
      }
      // childList mutations always target an element; the target sits inside a
      // block region when the region's own DOM is being re-rendered by Typora.
      const target = mutation.target instanceof HTMLElement ? mutation.target : null
      if (target?.closest('[data-tpl-note-key]')) return true
    }
    return false
  }

  private isOwnNode(node: Node): boolean {
    if (!(node instanceof HTMLElement)) return false
    return node.classList.contains('tpl-note-assistant-inline')
      || !!node.closest('.tpl-note-assistant-inline')
  }

  private process(): void {
    const root = this.writeEl
    if (!root) return
    this.withObserverPaused(() => {
      this.processCount += 1
      this.clear(root)

      const blocks = Array.from(root.children).filter((node): node is HTMLElement => node instanceof HTMLElement)
      const comments = Array.from(root.querySelectorAll<HTMLElement>('.md-comment'))
      let hasBlock = false
      let rendered = 0

      for (let index = 0; index < comments.length; index += 1) {
        const startComment = comments[index]
        if ((startComment.textContent || '').trim() !== BLOCK_START) continue

        const endComment = comments.slice(index + 1).find(el => (el.textContent || '').trim() === BLOCK_END)
        if (!endComment) continue

        const startBlock = getTopLevelBlock(startComment, root)
        const endBlock = getTopLevelBlock(endComment, root)
        if (!startBlock || !endBlock) continue

        const startIndex = blocks.indexOf(startBlock)
        const endIndex = blocks.indexOf(endBlock)
        if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) continue

        const key = startBlock.getAttribute('cid') || `note-assistant-${startIndex}`
        const sourceBlocks = blocks.slice(startIndex, endIndex + 1)

        hasBlock = true
        startComment.classList.add('tpl-note-assistant-comment')
        endComment.classList.add('tpl-note-assistant-comment')

        for (const block of sourceBlocks) {
          block.classList.add('tpl-note-assistant-source', 'tpl-note-assistant-source-hidden')
          block.dataset.tplNoteKey = key
        }

        const parsed = this.parseBlock(sourceBlocks)
        endBlock.insertAdjacentElement('afterend', this.renderBlock(parsed))
        rendered += 1
      }

      root.classList.toggle('tpl-has-note-assistant-block', hasBlock)
      this.renderedCount = rendered
    })
  }

  private clear(root: HTMLElement): void {
    root.querySelectorAll('.tpl-note-assistant-comment').forEach(el => {
      el.classList.remove('tpl-note-assistant-comment')
    })
    root.querySelectorAll('.tpl-note-assistant-inline').forEach(el => el.remove())
    root.querySelectorAll('.tpl-note-assistant-source').forEach(el => {
      el.classList.remove('tpl-note-assistant-source', 'tpl-note-assistant-source-hidden')
      delete (el as HTMLElement).dataset.tplNoteKey
    })
  }

  private parseBlock(sourceBlocks: HTMLElement[]): InlineBlock {
    const title = sourceBlocks.find(block => block.matches('h1,h2,h3,h4,h5,h6'))?.textContent?.trim() || '相关笔记'
    const listBlock = sourceBlocks.find(block => block.matches('ul,ol'))
    const items = listBlock
      ? Array.from(listBlock.children)
          .filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches('li'))
          .map(item => parseWikiLine(item.textContent || ''))
          .filter((item): item is NonNullable<typeof item> => !!item)
          .map(item => ({
            rawTarget: item.rawTarget,
            displayTitle: item.displayTitle || item.rawTarget.split('/').pop() || item.rawTarget,
          }))
      : []
    return { title, items }
  }

  private renderBlock(data: InlineBlock): HTMLElement {
    const panel = document.createElement('section')
    panel.className = 'tpl-note-assistant-inline'
    panel.setAttribute('contenteditable', 'false')

    const header = document.createElement('div')
    header.className = 'tpl-note-assistant-inline-header'

    const title = document.createElement('span')
    title.className = 'tpl-note-assistant-inline-title'
    title.textContent = data.title

    const count = document.createElement('span')
    count.className = 'tpl-note-assistant-inline-count'
    count.textContent = data.items.length ? `${data.items.length} 条` : ''

    const open = document.createElement('button')
    open.className = 'tpl-note-assistant-inline-open'
    open.type = 'button'
    open.textContent = '面板'
    open.title = '打开相关笔记面板 (Mod+;)'
    open.setAttribute('contenteditable', 'false')
    open.addEventListener('mousedown', evt => {
      evt.preventDefault()
      evt.stopPropagation()
    })
    open.addEventListener('click', evt => {
      evt.preventDefault()
      evt.stopPropagation()
      this.openPalette()
    })

    header.appendChild(title)
    header.appendChild(count)
    header.appendChild(open)
    panel.appendChild(header)

    const list = document.createElement('div')
    list.className = 'tpl-note-assistant-inline-list'
    for (const item of data.items) {
      list.appendChild(this.renderItem(item))
    }
    panel.appendChild(list)
    return panel
  }

  private renderItem(item: InlineItem): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'tpl-note-assistant-inline-item'
    button.type = 'button'
    button.setAttribute('contenteditable', 'false')
    button.title = item.rawTarget

    const title = document.createElement('span')
    title.className = 'tpl-note-assistant-inline-item-title'
    title.textContent = item.displayTitle

    const path = document.createElement('span')
    path.className = 'tpl-note-assistant-inline-item-path'
    path.textContent = item.rawTarget

    button.appendChild(title)
    button.appendChild(path)

    button.addEventListener('mousedown', evt => {
      evt.preventDefault()
      evt.stopPropagation()
    })
    button.addEventListener('click', evt => {
      evt.preventDefault()
      evt.stopPropagation()
      void this.openTarget(item.rawTarget)
    })
    return button
  }

  private async openTarget(rawTarget: string): Promise<void> {
    const currentFile = editor.getFilePath()
    if (!currentFile) return
    const { candidates } = targetCandidates(rawTarget, currentFile, this.store.rootDir())
    for (const candidate of candidates) {
      if (await platform.fs.exists(candidate)) {
        try {
          await editor.openFile(candidate)
          return
        } catch (err) {
          console.error('[tpl:note-assistant] open target failed', err)
        }
      }
    }
    console.warn('[tpl:note-assistant] failed to resolve target', { rawTarget, candidates })
  }

  private connectObserver(): void {
    if (!this.observer || !this.writeEl || this.observerConnected) return
    this.observer.observe(this.writeEl, { childList: true, subtree: true })
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

function getTopLevelBlock(node: Node, root: HTMLElement): HTMLElement | null {
  let current: Node | null = node
  while (current && current.parentNode && current.parentNode !== root) {
    current = current.parentNode
  }
  return current instanceof HTMLElement ? current : null
}
