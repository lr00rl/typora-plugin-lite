import { sanitizeInline, sanitizeText } from './privacy.js'
import type {
  ArchiveBranch,
  ArchiveEvent,
  ArchiveMode,
  SessionArchive,
} from './types.js'

export interface RenderOptions {
  title?: string
  generatedAt?: string
  mode?: ArchiveMode
  maxBodyBytes?: number
}

export interface MarkdownBlock {
  markdown: string
  label: string
  continuation?: string
}

export interface RenderedArchivePlan {
  archive: SessionArchive
  title: string
  providerName: string
  agentName: string
  generatedAt: string
  mode: ArchiveMode
  blocks: MarkdownBlock[]
  redactions: number
}

export interface RenderedArchive extends RenderedArchivePlan {
  markdown: string
}

export interface DocumentPart {
  index: number
  total: number
  previous?: string
  next?: string
  indexHref: string
}

interface RenderedBlocks {
  blocks: MarkdownBlock[]
  redactions: number
}

interface Turn {
  user: ArchiveEvent
  replies: ArchiveEvent[]
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
  return value.replace(/[\\*`[\]]/g, '\\$&')
}

function fencedBlock(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${value || '(empty)'}\n${fence}`
}

function bodyChunks(value: string, maxBytes: number): string[] {
  if (!Number.isFinite(maxBytes) || Buffer.byteLength(value) <= maxBytes) return [value]
  const source = Buffer.from(value)
  const chunks: string[] = []
  let start = 0
  while (start < source.length) {
    let end = Math.min(source.length, start + maxBytes)
    if (end < source.length) {
      const minimumBreak = start + Math.floor(maxBytes * 0.6)
      const newline = source.lastIndexOf(0x0a, end - 1)
      if (newline >= minimumBreak) end = newline + 1
      else {
        while (end > start && (source[end]! & 0xc0) === 0x80) end -= 1
      }
    }
    if (end <= start) end = Math.min(source.length, start + maxBytes)
    chunks.push(source.subarray(start, end).toString('utf8'))
    start = end
  }
  return chunks
}

function heading(level: number, value: string): string {
  return `${'#'.repeat(level)} ${value}`
}

function withTime(label: string, timestamp: string | undefined): string {
  const time = timestampLabel(timestamp)
  return time ? `${label} · ${time}` : label
}

function chunkedQuoteBlocks(
  level: number,
  label: string,
  body: string,
  maxBodyBytes: number,
  continuation?: string,
): MarkdownBlock[] {
  const chunks = bodyChunks(body || '(empty)', maxBodyBytes)
  return chunks.map((chunk, index) => {
    const chunkLabel = index === 0 ? label : `${label} · continued ${index + 1}/${chunks.length}`
    return {
      label: chunkLabel.replaceAll('*', ''),
      continuation,
      markdown: `${heading(level, chunkLabel)}\n\n${quoteBlock(chunk)}`,
    }
  })
}

function chunkedToolBlocks(
  level: number,
  label: string,
  body: string,
  maxBodyBytes: number,
  continuation?: string,
): MarkdownBlock[] {
  const chunks = bodyChunks(body || '(empty)', maxBodyBytes)
  return chunks.map((chunk, index) => {
    const chunkLabel = index === 0 ? label : `${label} · continued ${index + 1}/${chunks.length}`
    return {
      label: chunkLabel,
      continuation,
      markdown: `${heading(level, chunkLabel)}\n\n${fencedBlock(chunk)}`,
    }
  })
}

function turnsFrom(events: ArchiveEvent[]): { prelude: ArchiveEvent[]; turns: Turn[] } {
  const prelude: ArchiveEvent[] = []
  const turns: Turn[] = []
  let current: Turn | undefined
  for (const event of events) {
    if (event.role === 'user') {
      current = { user: event, replies: [] }
      turns.push(current)
    } else if (current) {
      current.replies.push(event)
    } else {
      prelude.push(event)
    }
  }
  return { prelude, turns }
}

function finalAssistantIndex(events: ArchiveEvent[]): number {
  let lastAssistant = -1
  let explicitFinal = -1
  events.forEach((event, index) => {
    if (event.role !== 'assistant') return
    lastAssistant = index
    if (/\bfinal(?:\s+answer)?\b/i.test(event.label ?? '')) explicitFinal = index
  })
  return explicitFinal >= 0 ? explicitFinal : lastAssistant
}

function renderVisibleEvent(
  event: ArchiveEvent,
  agentName: string,
  toolNames: Map<string, string>,
  options: {
    final: boolean
    assistantLevel: number
    detailLevel: number
    maxBodyBytes: number
    continuation?: string
  },
): RenderedBlocks {
  const body = sanitizeText(event.body)

  if (event.role === 'tool') {
    const knownName = event.toolName && event.toolName !== 'tool'
      ? event.toolName
      : event.toolId
        ? toolNames.get(event.toolId) ?? event.toolName
        : event.toolName
    if (event.toolId && event.toolName && event.toolName !== 'tool') {
      toolNames.set(event.toolId, event.toolName)
    }
    const name = sanitizeInline(knownName ?? 'tool')
    const phase = event.toolPhase === 'result' ? 'RESULT' : 'CALL'
    const label = withTime(`TOOL · ${markdownLabel(name.text)} · ${phase}`, event.timestamp)
    return {
      redactions: body.redactions + name.redactions,
      blocks: chunkedToolBlocks(
        options.detailLevel,
        label,
        body.text,
        options.maxBodyBytes,
        options.continuation,
      ),
    }
  }

  if (event.role === 'assistant') {
    const detail = sanitizeInline(event.label ?? 'reply')
    const label = options.final
      ? withTime(`${agentName} Answered`, event.timestamp)
      : `*${withTime(`${agentName} · ${markdownLabel(detail.text)}`, event.timestamp)}*`
    return {
      redactions: body.redactions + detail.redactions,
      blocks: chunkedQuoteBlocks(
        options.assistantLevel,
        label,
        body.text,
        options.maxBodyBytes,
        options.continuation,
      ),
    }
  }

  const rawLabel = event.role === 'attachment'
    ? 'ATTACHMENT'
    : event.role === 'notice'
      ? 'NOTE'
      : event.role.toUpperCase()
  const label = withTime(rawLabel, event.timestamp)
  return {
    redactions: body.redactions,
    blocks: chunkedQuoteBlocks(
      options.detailLevel,
      label,
      body.text,
      options.maxBodyBytes,
      options.continuation,
    ),
  }
}

function renderMainEvents(
  archive: SessionArchive,
  mode: ArchiveMode,
  maxBodyBytes: number,
  agentName: string,
): RenderedBlocks {
  const { prelude, turns } = turnsFrom(archive.events)
  const blocks: MarkdownBlock[] = []
  const toolNames = new Map<string, string>()
  let redactions = 0

  if (mode === 'full' && prelude.length > 0) {
    const finalIndex = finalAssistantIndex(prelude)
    prelude.forEach((event, index) => {
      const rendered = renderVisibleEvent(event, agentName, toolNames, {
        final: index === finalIndex,
        assistantLevel: 3,
        detailLevel: 4,
        maxBodyBytes,
        continuation: '## Session prelude · continued',
      })
      if (index === 0 && rendered.blocks[0]) {
        rendered.blocks[0].markdown = `## Session prelude\n\n${rendered.blocks[0].markdown}`
        rendered.blocks[0].continuation = undefined
      }
      redactions += rendered.redactions
      blocks.push(...rendered.blocks)
    })
  }

  for (const turn of turns) {
    const userBody = sanitizeText(turn.user.body)
    const userLabel = withTime('YOU', turn.user.timestamp)
    redactions += userBody.redactions
    blocks.push(...chunkedQuoteBlocks(2, userLabel, userBody.text, maxBodyBytes))

    const finalIndex = finalAssistantIndex(turn.replies)
    const selectedReplies = mode === 'answers'
      ? finalIndex >= 0 ? [turn.replies[finalIndex]!] : []
      : turn.replies
    selectedReplies.forEach((event, selectedIndex) => {
      const originalIndex = mode === 'answers' ? finalIndex : selectedIndex
      const continuation = mode === 'full' ? `## ${agentName} Replying · continued` : undefined
      const rendered = renderVisibleEvent(event, agentName, toolNames, {
        final: originalIndex === finalIndex,
        assistantLevel: mode === 'answers' ? 2 : 3,
        detailLevel: 4,
        maxBodyBytes,
        continuation,
      })
      if (mode === 'full' && selectedIndex === 0 && rendered.blocks[0]) {
        rendered.blocks[0].markdown = `## ${agentName} Replying\n\n${rendered.blocks[0].markdown}`
        rendered.blocks[0].continuation = undefined
      }
      redactions += rendered.redactions
      blocks.push(...rendered.blocks)
    })
  }

  return { blocks, redactions }
}

function renderBranch(
  branch: ArchiveBranch,
  agentName: string,
  maxBodyBytes: number,
  includeArchiveHeading: boolean,
): RenderedBlocks {
  const label = sanitizeInline(branch.label)
  const { prelude, turns } = turnsFrom(branch.events)
  const ordered = [...prelude, ...turns.flatMap(turn => [turn.user, ...turn.replies])]
  const finalIndex = finalAssistantIndex(ordered)
  const toolNames = new Map<string, string>()
  const blocks: MarkdownBlock[] = []
  let redactions = label.redactions
  const branchContext = `## Recovered branches · continued\n\n### ${markdownLabel(label.text)} · continued`

  ordered.forEach((event, index) => {
    let rendered: RenderedBlocks
    if (event.role === 'user') {
      const body = sanitizeText(event.body)
      redactions += body.redactions
      rendered = {
        redactions: 0,
        blocks: chunkedQuoteBlocks(
          4,
          withTime('YOU', event.timestamp),
          body.text,
          maxBodyBytes,
          branchContext,
        ),
      }
    } else {
      rendered = renderVisibleEvent(event, agentName, toolNames, {
        final: index === finalIndex,
        assistantLevel: 5,
        detailLevel: 6,
        maxBodyBytes,
        continuation: branchContext,
      })
      redactions += rendered.redactions
    }
    if (index === 0 && rendered.blocks[0]) {
      const prefix = includeArchiveHeading ? '## Recovered branches\n\n' : ''
      rendered.blocks[0].markdown = `${prefix}### ${markdownLabel(label.text)}\n\n${rendered.blocks[0].markdown}`
      rendered.blocks[0].continuation = includeArchiveHeading ? undefined : '## Recovered branches · continued'
    }
    blocks.push(...rendered.blocks)
  })

  return { blocks, redactions }
}

function renderHeader(plan: RenderedArchivePlan, part?: DocumentPart): string {
  const { archive } = plan
  const sessionId = sanitizeInline(archive.sessionId).text
  const frontmatter = [
    '---',
    'agent-session: 2',
    `agent-provider: ${archive.provider}`,
    `agent-session-id: ${yamlString(sessionId)}`,
    `agent-exported-at: ${yamlString(plan.generatedAt)}`,
    `agent-export-mode: ${plan.mode}`,
    `agent-source-count: ${archive.sourceCount}`,
    `agent-redactions: ${plan.redactions}`,
    ...(part ? [
      `agent-session-part: ${part.index}`,
      `agent-session-parts: ${part.total}`,
    ] : []),
    '---',
  ]
  const marker = part ? `\`SESSION ARCHIVE · PART ${part.index}/${part.total}\`` : '`SESSION ARCHIVE`'
  const title = part ? `${plan.title} · Part ${part.index}/${part.total}` : plan.title
  const metadata = [
    marker,
    `# ${markdownLabel(title)}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Agent | ${plan.providerName} |`,
    `| Session | \`${sessionId}\` |`,
    `| Export | ${plan.mode === 'answers' ? 'Prompts and final answers' : 'Full visible transcript'} |`,
    archive.startedAt ? `| Started | ${timestampLabel(archive.startedAt)} |` : '',
    archive.endedAt ? `| Ended | ${timestampLabel(archive.endedAt)} |` : '',
    `| Sources | ${archive.sourceCount} |`,
    plan.redactions > 0
      ? `| Privacy | ${plan.redactions} automatic redaction${plan.redactions === 1 ? '' : 's'} |`
      : '',
    part ? `| Part | ${part.index} of ${part.total} |` : '',
  ].filter(Boolean)
  if (part) {
    const navigation = [
      `[Archive index](${part.indexHref})`,
      part.previous ? `[← Previous](${part.previous})` : '',
      part.next ? `[Next →](${part.next})` : '',
    ].filter(Boolean).join(' · ')
    metadata.push('', navigation)
  }
  return `${frontmatter.join('\n')}\n\n${metadata.join('\n')}`
}

export function renderArchiveDocument(
  plan: RenderedArchivePlan,
  blocks: MarkdownBlock[] = plan.blocks,
  part?: DocumentPart,
): string {
  const content: string[] = []
  if (blocks[0]?.continuation) content.push(blocks[0].continuation)
  content.push(...blocks.map(block => block.markdown))
  if (content.length === 0) content.push('> No visible user or assistant messages were recovered.')
  const footer = plan.mode === 'answers'
    ? '*Exported locally by `session-archive`. Only user prompts and each turn’s final visible answer are included. Hidden reasoning and instructions are excluded.*'
    : '*Exported locally by `session-archive`. Hidden reasoning, system prompts, and developer instructions are intentionally excluded.*'
  return `${[renderHeader(plan, part), ...content, '---', footer].join('\n\n')}\n`
}

export function renderMarkdown(archive: SessionArchive, options: RenderOptions = {}): RenderedArchive {
  const firstUser = archive.events.find(event => event.role === 'user')?.body
  const providerName = archive.provider === 'codex' ? 'Codex' : 'Claude Code'
  const agentName = archive.provider === 'codex' ? 'CODEX' : 'CLAUDE'
  const rawTitle = options.title ?? archive.title ?? (firstUser ? truncateTitle(firstUser) : `${providerName} session`)
  const title = sanitizeInline(rawTitle)
  const sessionId = sanitizeInline(archive.sessionId)
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const mode = options.mode ?? 'full'
  const maxBodyBytes = Math.max(1_024, options.maxBodyBytes ?? Number.POSITIVE_INFINITY)
  const main = renderMainEvents(archive, mode, maxBodyBytes, agentName)
  const blocks = [...main.blocks]
  let redactions = title.redactions + sessionId.redactions + main.redactions

  if (mode === 'full') {
    archive.branches.forEach((branch, index) => {
      const rendered = renderBranch(branch, agentName, maxBodyBytes, index === 0)
      redactions += rendered.redactions
      blocks.push(...rendered.blocks)
    })
  }

  const plan: RenderedArchivePlan = {
    archive,
    title: title.text,
    providerName,
    agentName,
    generatedAt,
    mode,
    blocks,
    redactions,
  }
  return { ...plan, markdown: renderArchiveDocument(plan) }
}
