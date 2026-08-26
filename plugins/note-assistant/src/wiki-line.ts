/**
 * Parse and compose the `- [[target|title]] - reason` lines that live inside
 * note-assistant blocks. `composeWikiLine` is byte-compatible with the vault
 * generator (tools/note-assistant/lib.mjs writes exactly this shape), and the
 * round-trip is pinned by tests so the plugin and the pipeline can never drift
 * apart silently.
 */

export interface WikiLine {
  /** Raw link target as written, heading suffix (`#...`) preserved. */
  rawTarget: string
  displayTitle: string
  reasonText: string
}

const WIKI_LINE_RE = /\[\[([^|\]]+)(?:\|([^\]]+))?\]\](?:\s*-\s*(.+))?$/

/** Parse one list item or bare line; returns null when no wiki-link is present. */
export function parseWikiLine(rawText: string): WikiLine | null {
  const text = rawText
    .replace(/^[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()

  const match = text.match(WIKI_LINE_RE)
  if (!match) return null

  const rawTarget = match[1].trim()
  if (!rawTarget) return null
  const displayTitle = (match[2] || '').trim()
  const reasonText = (match[3] || '').trim()

  return { rawTarget, displayTitle, reasonText }
}

export function composeWikiLine(item: { target: string; title: string; reasonText?: string }): string {
  const link = `[[${item.target}|${item.title}]]`
  const reason = (item.reasonText || '').trim()
  return `- ${link}${reason ? ` - ${reason}` : ''}`
}

/**
 * Permissive variant for generated index blocks, where a link is followed by a
 * count rather than the ` - reason` shape `parseWikiLine` expects
 * (`- [[ssh/00_索引|ssh]]（6 篇）`). Takes the first `[[...]]` anywhere in the
 * line and returns whatever trails it, with a leading ` - ` separator stripped
 * so both shapes collapse to the same result.
 */
export const WIKI_INLINE_RE = /\[\[([^|\][]+)(?:\|([^\]]*))?\]\]/

export interface WikiItem {
  rawTarget: string
  displayTitle: string
  trailing: string
}

export function parseWikiItem(rawText: string): WikiItem | null {
  const text = rawText
    .replace(/^[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()

  const match = text.match(WIKI_INLINE_RE)
  if (!match || match.index === undefined) return null

  const rawTarget = match[1].trim()
  if (!rawTarget) return null

  const trailing = text
    .slice(match.index + match[0].length)
    .replace(/^\s*[-–]\s*/, '')
    .trim()

  return { rawTarget, displayTitle: (match[2] || '').trim(), trailing }
}
