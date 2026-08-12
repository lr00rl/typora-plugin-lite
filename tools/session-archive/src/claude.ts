import { basename } from 'node:path'

import { visitStableJsonl } from './jsonl.js'
import type {
  ArchiveBranch,
  ArchiveDiagnostic,
  ArchiveEvent,
  ParseOptions,
  SessionArchive,
  SourceFile,
} from './types.js'

type JsonObject = Record<string, unknown>

interface ClaudeNode {
  uuid: string
  parentUuid?: string
  timestamp?: string
  index: number
  isSidechain: boolean
  agentId?: string
  value: JsonObject
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map(block => {
      const item = object(block)
      if (!item) return ''
      if (item.type === 'text') return string(item.text) ?? ''
      if (item.type === 'image') return '[Image attachment]'
      if (item.type === 'document') return '[Document attachment]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function blockResultText(block: JsonObject): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = contentText(content)
    return text || displayValue(content)
  }
  return displayValue(content)
}

function nodeEvents(node: ClaudeNode, prefix: string): ArchiveEvent[] {
  const top = node.value
  if (top.isMeta === true) return []
  const message = object(top.message)
  const role = string(message?.role) ?? string(top.type)
  const content = message?.content
  const result: ArchiveEvent[] = []
  let part = 0
  const id = () => `${prefix}-${node.index}-${part++}`

  if (role === 'assistant') {
    if (typeof content === 'string' && content.trim()) {
      result.push({ id: id(), role: 'assistant', body: content, timestamp: node.timestamp })
      return result
    }
    if (!Array.isArray(content)) return result
    for (const rawBlock of content) {
      const block = object(rawBlock)
      if (!block) continue
      if (block.type === 'text') {
        const body = string(block.text) ?? ''
        if (body.trim()) result.push({ id: id(), role: 'assistant', body, timestamp: node.timestamp })
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        result.push({
          id: id(),
          role: 'tool',
          body: displayValue(block.input),
          timestamp: node.timestamp,
          toolId: string(block.id),
          toolName: string(block.name) ?? 'tool',
          toolPhase: 'call',
        })
      } else if (block.type === 'image' || block.type === 'document') {
        result.push({
          id: id(),
          role: 'attachment',
          body: block.type === 'image' ? 'Image attachment' : 'Document attachment',
          timestamp: node.timestamp,
        })
      }
      // thinking and redacted_thinking are deliberately private and omitted.
    }
    return result
  }

  if (role !== 'user') return result
  if (typeof content === 'string') {
    if (content.trim()) result.push({ id: id(), role: 'user', body: content, timestamp: node.timestamp })
    return result
  }
  if (!Array.isArray(content)) return result

  const textParts: string[] = []
  let sawToolResult = false
  for (const rawBlock of content) {
    const block = object(rawBlock)
    if (!block) continue
    if (block.type === 'text') {
      const text = string(block.text)
      if (text?.trim()) textParts.push(text)
    } else if (block.type === 'tool_result' || block.type === 'web_search_tool_result') {
      sawToolResult = true
      result.push({
        id: id(),
        role: 'tool',
        body: blockResultText(block),
        timestamp: node.timestamp,
        toolId: string(block.tool_use_id),
        toolName: 'tool',
        toolPhase: 'result',
      })
    } else if (block.type === 'image' || block.type === 'document') {
      result.push({
        id: id(),
        role: 'attachment',
        body: block.type === 'image' ? 'Image attachment' : 'Document attachment',
        timestamp: node.timestamp,
      })
    }
  }
  if (textParts.length > 0) {
    result.unshift({ id: id(), role: 'user', body: textParts.join('\n'), timestamp: node.timestamp })
  }
  if (!sawToolResult && top.toolUseResult !== undefined) {
    result.push({
      id: id(),
      role: 'tool',
      body: displayValue(top.toolUseResult),
      timestamp: node.timestamp,
      toolName: 'tool',
      toolPhase: 'result',
    })
  }
  return result
}

function chainForTip(nodes: Map<string, ClaudeNode>, tip: ClaudeNode): ClaudeNode[] {
  const chain: ClaudeNode[] = []
  const visited = new Set<string>()
  let current: ClaudeNode | undefined = tip
  while (current && !visited.has(current.uuid)) {
    visited.add(current.uuid)
    chain.push(current)
    current = current.parentUuid ? nodes.get(current.parentUuid) : undefined
  }
  return chain.reverse()
}

function newest(nodes: ClaudeNode[]): ClaudeNode | undefined {
  return [...nodes].sort((a, b) => {
    const byTime = (b.timestamp ?? '').localeCompare(a.timestamp ?? '')
    return byTime || b.index - a.index
  })[0]
}

function visibleLeaves(nodes: Map<string, ClaudeNode>, sidechain: boolean): ClaudeNode[] {
  const parents = new Set<string>()
  for (const node of nodes.values()) {
    if (node.parentUuid && node.isSidechain === sidechain) parents.add(node.parentUuid)
  }
  return [...nodes.values()].filter(node => node.isSidechain === sidechain && !parents.has(node.uuid))
}

function eventsForChain(chain: ClaudeNode[], prefix: string): ArchiveEvent[] {
  return chain.flatMap(node => nodeEvents(node, prefix))
}

async function readClaudeFile(
  source: SourceFile,
  diagnostics: ArchiveDiagnostic[],
): Promise<Map<string, ClaudeNode>> {
  const nodes = new Map<string, ClaudeNode>()
  let index = 0
  const issues = await visitStableJsonl(source.path, record => {
    const value = object(record.value)
    if (!value || (value.type !== 'user' && value.type !== 'assistant')) return
    const uuid = string(value.uuid)
    if (!uuid) return
    nodes.set(uuid, {
      uuid,
      parentUuid: string(value.parentUuid),
      timestamp: string(value.timestamp),
      index: index++,
      isSidechain: value.isSidechain === true || source.kind === 'subagent',
      agentId: string(value.agentId),
      value,
    })
  })
  for (const issue of issues) {
    diagnostics.push({
      level: 'warning',
      code: 'INVALID_JSONL_LINE',
      message: `${basename(source.path)}:${issue.line} was skipped`,
    })
  }
  return nodes
}

export async function parseClaudeSession(
  sessionId: string,
  sources: SourceFile[],
  options: ParseOptions,
): Promise<SessionArchive> {
  const diagnostics: ArchiveDiagnostic[] = []
  const mainSources = sources.filter(source => source.kind !== 'subagent')
  if (mainSources.length !== 1) {
    throw new Error(`AMBIGUOUS_SESSION: found ${mainSources.length} Claude transcripts; pass --source`)
  }

  const mainNodes = await readClaudeFile(mainSources[0]!, diagnostics)
  const mainCandidates = [...mainNodes.values()].filter(node => !node.isSidechain)
  const primaryTip = newest(visibleLeaves(mainNodes, false)) ?? newest(mainCandidates)
  const primaryChain = primaryTip ? chainForTip(mainNodes, primaryTip) : []
  const primaryIds = new Set(primaryChain.map(node => node.uuid))
  const events = eventsForChain(primaryChain, 'claude-main')
  const branches: ArchiveBranch[] = []

  if (options.includeBranches) {
    let alternateIndex = 0
    for (const leaf of visibleLeaves(mainNodes, false)) {
      if (leaf.uuid === primaryTip?.uuid) continue
      const suffix = chainForTip(mainNodes, leaf).filter(node => !primaryIds.has(node.uuid))
      const branchEvents = eventsForChain(suffix, `claude-alt-${alternateIndex}`)
      if (branchEvents.length > 0) {
        alternateIndex += 1
        branches.push({
          id: `alternate-${alternateIndex}`,
          label: `Alternate branch ${alternateIndex}`,
          kind: 'alternate',
          events: branchEvents,
        })
      }
    }

    const sidechainGroups = new Map<string, ClaudeNode[]>()
    for (const node of mainNodes.values()) {
      if (!node.isSidechain) continue
      const key = node.agentId ?? 'inline-sidechain'
      const group = sidechainGroups.get(key) ?? []
      group.push(node)
      sidechainGroups.set(key, group)
    }
    for (const source of sources.filter(item => item.kind === 'subagent')) {
      const nodes = await readClaudeFile(source, diagnostics)
      const group = [...nodes.values()]
      if (group.length > 0) sidechainGroups.set(basename(source.path, '.jsonl'), group)
    }

    let sidechainIndex = 0
    for (const [agentId, group] of sidechainGroups) {
      const map = new Map(group.map(node => [node.uuid, node]))
      const tip = newest(visibleLeaves(map, true)) ?? newest(group)
      const chain = tip ? chainForTip(map, tip) : [...group].sort((a, b) => a.index - b.index)
      const branchEvents = eventsForChain(chain, `claude-side-${sidechainIndex}`)
      if (branchEvents.length > 0) {
        sidechainIndex += 1
        branches.push({
          id: `sidechain-${sidechainIndex}`,
          label: `Subagent · ${agentId}`,
          kind: 'sidechain',
          events: branchEvents,
        })
      }
    }
  }

  const allNodes = [...mainNodes.values()]
  const timestamps = allNodes.map(node => node.timestamp).filter((value): value is string => Boolean(value)).sort()
  const firstValue = primaryChain[0]?.value ?? allNodes[0]?.value
  return {
    provider: 'claude',
    sessionId,
    project: string(firstValue?.cwd),
    startedAt: timestamps[0],
    endedAt: timestamps.at(-1),
    events,
    branches,
    sourceCount: sources.length,
    diagnostics,
  }
}
