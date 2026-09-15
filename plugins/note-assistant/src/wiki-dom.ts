/**
 * Flatten a Typora block to the markdown it still carries in the DOM, and wrap
 * a character range that may span the emphasis nodes `_…_` was turned into.
 *
 * Typora does not delete underscores: it hides them in `.md-meta` and puts the
 * inner run in `<em>`. A closer `_` on a later wiki-link can swallow `]]…[[`
 * in between, so a text-node scanner never sees a complete `[[…]]`. Scanning
 * concatenated text (meta included) recovers the original links. Wrapping
 * must not add or drop characters: the host serializes `#write` back to disk.
 */

import { WIKI_INLINE_RE } from './wiki-line.js'

export interface TextMapEntry {
  node: Text
  offset: number
}

export interface FlattenedMarkdown {
  text: string
  map: TextMapEntry[]
}

export interface WikiMatch {
  whole: string
  target: string
  title: string | undefined
  index: number
}

const SCAN_RE = new RegExp(WIKI_INLINE_RE.source, 'g')

export function flattenMarkdownText(root: HTMLElement, skipSelector: string): FlattenedMarkdown {
  const map: TextMapEntry[] = []
  const chars: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node) => {
      const parent = (node as Text).parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest(skipSelector)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let current = walker.nextNode()
  while (current) {
    const textNode = current as Text
    const value = textNode.nodeValue || ''
    for (let i = 0; i < value.length; i++) {
      chars.push(value[i] as string)
      map.push({ node: textNode, offset: i })
    }
    current = walker.nextNode()
  }
  return { text: chars.join(''), map }
}

export function wikiMatchesIn(text: string): WikiMatch[] {
  const out: WikiMatch[] = []
  SCAN_RE.lastIndex = 0
  let match = SCAN_RE.exec(text)
  while (match) {
    const target = (match[1] || '').trim()
    if (target) {
      out.push({
        whole: match[0],
        target,
        title: match[2],
        index: match.index,
      })
    }
    match = SCAN_RE.exec(text)
  }
  return out
}

/** True when the match is split across text nodes (Typora emphasis, pair spans). */
export function matchCrossesTextNodes(map: TextMapEntry[], match: WikiMatch): boolean {
  const slice = map.slice(match.index, match.index + match.whole.length)
  if (slice.length === 0) return false
  const first = slice[0]?.node
  return slice.some(entry => entry.node !== first)
}

/**
 * Wrap the DOM range covered by `slice`. `surroundContents` fails when the
 * range splits an `<em>` (the common case); extract-and-insert splits that
 * element and keeps every character.
 */
export function wrapMappedRange(slice: TextMapEntry[]): HTMLElement | null {
  if (!slice.length) return null
  const from = slice[0]
  const to = slice[slice.length - 1]
  if (!from || !to) return null
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset + 1)
  const wrapper = document.createElement('span')
  try {
    range.surroundContents(wrapper)
  } catch {
    wrapper.appendChild(range.extractContents())
    range.insertNode(wrapper)
  }
  return wrapper.isConnected ? wrapper : null
}

export function displayLabel(match: WikiMatch): string {
  if (match.title !== undefined) return match.title
  const slash = match.target.lastIndexOf('/')
  return slash >= 0 ? match.target.slice(slash + 1) : match.target
}
