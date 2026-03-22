/**
 * Pangu spacing algorithm — core logic.
 * Adds spaces between CJK and half-width characters.
 * Ported from pangu.js (MIT) — minimal implementation.
 */

// CJK Unified Ideographs + Extensions + Compatibility Ideographs
const CJK =
  '\u2e80-\u2eff\u2f00-\u2fdf\u3040-\u309f\u30a0-\u30ff\u3100-\u312f' +
  '\u3200-\u32ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f'

// Characters that should NOT have a space added around them in certain contexts
const ANS = `A-Za-z0-9`
const HASHMARK = `#`

// Patterns: CJK followed by ANS, or ANS followed by CJK
const CJK_ANS = new RegExp(`([${CJK}])([${ANS}${HASHMARK}])`, 'g')
const ANS_CJK = new RegExp(`([${ANS}%])([${CJK}])`, 'g')

// CJK with operators/symbols
const CJK_BRACKET_L = new RegExp(`([${CJK}])([\\(\\[\\{])`, 'g')
const BRACKET_R_CJK = new RegExp(`([\\)\\]\\}])([${CJK}])`, 'g')
const CJK_QUOTE_L = new RegExp(`([${CJK}])(["\`])`, 'g')
const QUOTE_R_CJK = new RegExp(`(["\`])([${CJK}])`, 'g')

// CJK with special characters
const FIX_SLASH = new RegExp(`([${CJK}])(\/)([${CJK}])`, 'g')
const FIX_TILDE = new RegExp(`([${CJK}])(~)([${CJK}])`, 'g')

/**
 * Core pangu spacing function.
 * Processes a single line — does NOT touch inside code 、fenced blocks, or links.
 */
function spacingLine(text: string): string {
  let result = text

  // CJK + alphanumeric
  result = result.replace(CJK_ANS, '$1 $2')
  result = result.replace(ANS_CJK, '$1 $2')

  // CJK + bracket
  result = result.replace(CJK_BRACKET_L, '$1 $2')
  result = result.replace(BRACKET_R_CJK, '$1 $2')

  // CJK + quote
  result = result.replace(CJK_QUOTE_L, '$1 $2')
  result = result.replace(QUOTE_R_CJK, '$1 $2')

  // CJK / CJK → CJK / CJK (preserve slash)
  result = result.replace(FIX_SLASH, '$1 $2 $3')
  result = result.replace(FIX_TILDE, '$1 $2 $3')

  return result
}

/**
 * Format markdown text with pangu spacing.
 * Skips code blocks, frontmatter, and inline code.
 */
export function padMarkdown(markdown: string): string {
  const lines = markdown.split('\n')
  const result: string[] = []
  let inFencedBlock = false
  let inFrontmatter = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Handle frontmatter (--- at start of file)
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true
      result.push(line)
      continue
    }
    if (inFrontmatter) {
      if (line.trim() === '---') {
        inFrontmatter = false
      }
      result.push(line)
      continue
    }

    // Handle fenced code blocks
    if (line.trimStart().startsWith('```') || line.trimStart().startsWith('~~~')) {
      inFencedBlock = !inFencedBlock
      result.push(line)
      continue
    }
    if (inFencedBlock) {
      result.push(line)
      continue
    }

    // Process the line, but protect inline code and links
    result.push(spacingLineProtected(line))
  }

  return result.join('\n')
}

/**
 * Apply spacing to a line while protecting inline code, links, and images.
 * Protected tokens: `code`, [text](url), ![alt](url), <url>
 */
function spacingLineProtected(line: string): string {
  // Match inline code, images, links, and auto-links — order matters (images before links)
  const PROTECTED = /(`[^`]*`|!\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\([^)]*\)|<https?:\/\/[^>]+>)/g

  const tokens: string[] = []
  let lastIndex = 0
  const result: string[] = []

  let match: RegExpExecArray | null
  while ((match = PROTECTED.exec(line)) !== null) {
    // Process text before this token
    if (match.index > lastIndex) {
      result.push(spacingLine(line.slice(lastIndex, match.index)))
    }
    // Preserve the protected token as-is
    tokens.push(match[0])
    result.push(match[0])
    lastIndex = PROTECTED.lastIndex
  }

  // Process remaining text after last token
  if (lastIndex < line.length) {
    result.push(spacingLine(line.slice(lastIndex)))
  }

  return result.join('')
}
