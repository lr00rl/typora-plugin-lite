import { sanitizeInline, sanitizeText } from './privacy.js'
import type { ArchiveBranch, ArchiveEvent, SessionArchive } from './types.js'

export interface RenderOptions {
  title?: string
  generatedAt?: string
}

export interface RenderedArchive {
  markdown: string
  redactions: number
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function truncateTitle(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > 72 ? `${chars.slice(0, 71).join('')}…` : flat
}

function timestampLabel(value: string | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().replace('T', ' ').replace(/\.000Z$/, 'Z')
}

function quoteBlock(value: string): string {
  return value.split('\n').map(line => line ? `> ${line}` : '>').join('\n')
}

function markdownLabel(value: string): string {
  return value.replace(/[\\*_`[\]]/g, '\\$&')
}

function fencedBlock(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${value || '(empty)'}\n${fence}`
}

function roleLabel(event: ArchiveEvent, provider: SessionArchive['provider']): string {
  if (event.role === 'user') return 'YOU'
  if (event.role === 'assistant') return provider === 'codex' ? 'CODEX' : 'CLAUDE'
  if (event.role === 'attachment') return 'ATTACHMENT'
  return 'NOTE'
}

function roleClass(event: ArchiveEvent): string {
  if (event.role === 'user') return 'user'
  if (event.role === 'assistant') return 'assistant'
  return 'notice'
}

function renderEvent(
  event: ArchiveEvent,
  archive: SessionArchive,
  toolNames: Map<string, string>,
): { markdown: string; redactions: number } {
  const body = sanitizeText(event.body)
  const time = timestampLabel(event.timestamp)

  if (event.role === 'tool') {
    const knownName = event.toolName && event.toolName !== 'tool'
      ? event.toolName
      : event.toolId
        ? toolNames.get(event.toolId) ?? event.toolName
        : event.toolName
    if (event.toolId && event.toolName && event.toolName !== 'tool') toolNames.set(event.toolId, event.toolName)
    const name = sanitizeInline(knownName ?? 'tool')
    const phase = event.toolPhase === 'result' ? 'RESULT' : 'CALL'
    const meta = time ? ` · ${time}` : ''
    return {
      redactions: body.redactions + name.redactions,
      markdown: [
        `**TOOL · ${phase} · ${markdownLabel(name.text)}${meta}**`,
        fencedBlock(body.text),
      ].join('\n'),
    }
  }

  const label = roleLabel(event, archive.provider)
  const detail = event.label ? ` · ${markdownLabel(sanitizeInline(event.label).text)}` : ''
  const meta = time ? ` · ${time}` : ''
  const role = `${label}${detail}${meta}`
  return {
    redactions: body.redactions,
    markdown: [
      roleClass(event) === 'assistant' ? `*${role}*` : `**${role}**`,
      quoteBlock(body.text || '(empty)'),
    ].join('\n'),
  }
}

function renderEvents(events: ArchiveEvent[], archive: SessionArchive): RenderedArchive {
  const output: string[] = []
  const toolNames = new Map<string, string>()
  let redactions = 0
  for (const event of events) {
    const rendered = renderEvent(event, archive, toolNames)
    redactions += rendered.redactions
    output.push(rendered.markdown)
  }
  return { markdown: output.join('\n\n'), redactions }
}

function renderBranch(branch: ArchiveBranch, archive: SessionArchive): RenderedArchive {
  const label = sanitizeInline(branch.label)
  const events = renderEvents(branch.events, archive)
  return {
    redactions: label.redactions + events.redactions,
    markdown: [
      `### ${markdownLabel(label.text)}`,
      '',
      events.markdown,
    ].join('\n'),
  }
}

export function renderMarkdown(archive: SessionArchive, options: RenderOptions = {}): RenderedArchive {
  const firstUser = archive.events.find(event => event.role === 'user')?.body
  const providerName = archive.provider === 'codex' ? 'Codex' : 'Claude Code'
  const rawTitle = options.title ?? archive.title ?? (firstUser ? truncateTitle(firstUser) : `${providerName} session`)
  const title = sanitizeInline(rawTitle)
  const sessionId = sanitizeInline(archive.sessionId)
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const main = renderEvents(archive.events, archive)
  const branches = archive.branches.map(branch => renderBranch(branch, archive))
  const redactions = title.redactions + sessionId.redactions + main.redactions
    + branches.reduce((sum, branch) => sum + branch.redactions, 0)

  const frontmatter = [
    '---',
    'agent-session: 1',
    `agent-provider: ${archive.provider}`,
    `agent-session-id: ${yamlString(sessionId.text)}`,
    `agent-exported-at: ${yamlString(generatedAt)}`,
    `agent-source-count: ${archive.sourceCount}`,
    `agent-redactions: ${redactions}`,
    '---',
  ]
  const metadata = [
    '`SESSION ARCHIVE`',
    `# ${markdownLabel(title.text)}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Agent | ${providerName} |`,
    `| Session | \`${sessionId.text}\` |`,
    archive.startedAt ? `| Started | ${timestampLabel(archive.startedAt)} |` : '',
    archive.endedAt ? `| Ended | ${timestampLabel(archive.endedAt)} |` : '',
    `| Sources | ${archive.sourceCount} |`,
    redactions > 0 ? `| Privacy | ${redactions} automatic redaction${redactions === 1 ? '' : 's'} |` : '',
  ].filter(Boolean)
  const sections = [
    frontmatter.join('\n'),
    metadata.join('\n'),
    '## Conversation',
    main.markdown || '> No visible user or assistant messages were recovered.',
  ]
  if (branches.length > 0) {
    sections.push('## Recovered branches', branches.map(branch => branch.markdown).join('\n\n'))
  }
  sections.push(
    '---',
    '*Exported locally by `session-archive`. Hidden reasoning, system prompts, and developer instructions are intentionally excluded.*',
  )

  return { markdown: `${sections.join('\n\n')}\n`, redactions }
}
