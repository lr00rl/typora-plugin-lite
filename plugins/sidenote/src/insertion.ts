export const SIDENOTE_TAG_OPEN = '<span class="sidenote">'
export const SIDENOTE_TAG_CLOSE = '</span>'

export function formatSidenoteInsertion(selectedText: string): string {
  const content = escapeHtml(normalizeInlineContent(selectedText))
  return `${SIDENOTE_TAG_OPEN}${content}${SIDENOTE_TAG_CLOSE}`
}

export function normalizeInlineContent(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
