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
