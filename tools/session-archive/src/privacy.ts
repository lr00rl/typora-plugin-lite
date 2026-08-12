import { homedir } from 'node:os'

export interface SanitizedText {
  text: string
  redactions: number
}

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_\-]{16,}\b/g, '[REDACTED API KEY]'],
  [/\b(?:ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_\-]{16,}\b/g, '[REDACTED TOKEN]'],
  [/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED AWS ACCESS KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+\-/]+=*\b/gi, 'Bearer [REDACTED TOKEN]'],
  [
    /(^|\n)(\s*(?:export\s+)?(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)\s*[=:]\s*)([^\s#]+)/gi,
    '$1$2[REDACTED]',
  ],
]

function replaceAndCount(input: string, pattern: RegExp, replacement: string): SanitizedText {
  let redactions = 0
  const text = input.replace(pattern, (...args: unknown[]) => {
    redactions += 1
    if (replacement.includes('$')) {
      const match = args[0] as string
      const groups = args.slice(1, -2) as string[]
      return replacement.replace(/\$(\d+)/g, (_token, index: string) => groups[Number(index) - 1] ?? match)
    }
    return replacement
  })
  return { text, redactions }
}

/**
 * Redact high-confidence secrets and local home paths, then neutralize active
 * HTML/URI payloads so archived untrusted model output remains inert in Typora.
 */
export function sanitizeText(input: string): SanitizedText {
  let text = input.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
  let redactions = 0

  const homes = new Set(
    [homedir(), process.env.USERPROFILE, process.env.HOME]
      .filter((value): value is string => Boolean(value))
      .map(value => value.replace(/[\\/]+$/, '')),
  )
  for (const home of homes) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const result = replaceAndCount(text, new RegExp(escaped, 'g'), '~')
    text = result.text
    redactions += result.redactions
  }

  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    const result = replaceAndCount(text, pattern, replacement)
    text = result.text
    redactions += result.redactions
  }

  text = text
    // Prevent archived content from loading remote/local images merely by
    // opening the note. The syntax remains readable as literal Markdown.
    .replace(/!\[/g, '\\![')
    .replace(/\]\(\s*(?:javascript|vbscript|data|file):/gi, '](unsafe-uri:')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return { text, redactions }
}

export function sanitizeInline(input: string): SanitizedText {
  const result = sanitizeText(input)
  return {
    text: result.text.replace(/\s+/g, ' ').trim(),
    redactions: result.redactions,
  }
}
