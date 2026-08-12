import { basename } from 'node:path'

import { visitStableJsonl } from './jsonl.js'
import type {
  ArchiveDiagnostic,
  ArchiveEvent,
  ParseOptions,
  SessionArchive,
  SourceFile,
} from './types.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function textContent(value: unknown, omitContextual = false): string {
  if (typeof value === 'string') return omitContextual && isContextualUserText(value) ? '' : value
  if (!Array.isArray(value)) return ''
  return value
    .map(part => {
      const item = object(part)
      if (!item) return ''
      if (item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') {
        const text = string(item.text) ?? ''
        return omitContextual && isContextualUserText(text) ? '' : text
      }
      if (item.type === 'input_image') return '[Image attachment]'
      if (item.type === 'input_audio') return '[Audio attachment]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
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

function displayOutput(value: unknown): string {
  const output = object(value)
  if (!output) return displayValue(value)
  if (typeof output.content === 'string') return output.content
  if (Array.isArray(output.content_items)) {
    return textContent(output.content_items) || displayValue(output.content_items)
  }
  return displayValue(value)
}

function isContextualUserText(value: string): boolean {
  const text = value.trim()
  const enclosedFragments: Array<[string, string]> = [
    ['# AGENTS.md instructions', '</INSTRUCTIONS>'],
    ['<environment_context>', '</environment_context>'],
    ['<skill>', '</skill>'],
    ['<user_shell_command>', '</user_shell_command>'],
    ['<turn_aborted>', '</turn_aborted>'],
    ['<subagent_notification>', '</subagent_notification>'],
    ['<recommended_plugins>', '</recommended_plugins>'],
    ['<goal_context>', '</goal_context>'],
  ]
  if (enclosedFragments.some(([start, end]) => text.startsWith(start) && text.endsWith(end))) {
    return true
  }
  if (text.startsWith('<hook_prompt') && text.endsWith('</hook_prompt>')) return true
  if (text.startsWith('<codex_internal_context') && text.endsWith('</codex_internal_context>')) return true
  if (text.startsWith('<external_')) {
    const tagEnd = text.indexOf('>')
    const tag = tagEnd > 0
      ? text.slice('<external_'.length, tagEnd).split(/\s/, 1)[0]
      : undefined
    if (tag && text.endsWith(`</external_${tag}>`)) return true
  }
  return text.startsWith('Warning: The maximum number of unified exec processes you can keep open is')
    || (text.startsWith('Warning: apply_patch was requested via ')
      && text.endsWith('Use the apply_patch tool instead of exec_command.'))
    || text.startsWith('Warning: Your account was flagged for potentially high-risk cyber activity')
}

function responseItemEvent(
  payload: JsonObject,
  timestamp: string | undefined,
  id: string,
): ArchiveEvent | undefined {
  const type = string(payload.type)
  if (!type || type === 'reasoning' || type === 'additional_tools') return undefined

  if (type === 'message') {
    const role = string(payload.role)
    if (role !== 'user' && role !== 'assistant') return undefined
    const body = textContent(payload.content, role === 'user')
    if (!body.trim()) return undefined
    return {
      id,
      role,
      body,
      timestamp,
      label: role === 'assistant' && typeof payload.phase === 'string'
        ? payload.phase.replaceAll('_', ' ')
        : undefined,
    }
  }

  if (type === 'agent_message') {
    const body = textContent(payload.content)
    if (!body.trim()) return undefined
    const author = string(payload.author) ?? 'agent'
    const recipient = string(payload.recipient) ?? 'agent'
    return {
      id,
      role: 'assistant',
      body,
      timestamp,
      label: `subagent · ${author} → ${recipient}`,
    }
  }

  if (type === 'image_generation_call') {
    const prompt = string(payload.revised_prompt)
    const status = string(payload.status)
    return {
      id,
      role: 'tool',
      body: [status ? `status: ${status}` : '', prompt ? `revised prompt: ${prompt}` : '', '[generated image payload omitted]']
        .filter(Boolean)
        .join('\n'),
      timestamp,
      toolId: string(payload.id),
      toolName: 'image generation',
      toolPhase: 'result',
    }
  }

  const callId = string(payload.call_id) ?? string(payload.id)
  const toolNames: Record<string, string> = {
    function_call: string(payload.name) ?? 'function',
    custom_tool_call: string(payload.name) ?? 'tool',
    local_shell_call: 'shell',
    web_search_call: 'web search',
    file_search_call: 'file search',
    computer_call: 'computer',
    tool_search_call: 'tool search',
    mcp_call: string(payload.name) ?? 'MCP tool',
  }
  const outputTypes = new Set([
    'function_call_output',
    'custom_tool_call_output',
    'local_shell_call_output',
    'computer_call_output',
    'tool_search_output',
    'mcp_call_output',
  ])

  if (type in toolNames) {
    const body = type === 'function_call'
      ? displayValue(payload.arguments)
      : type === 'custom_tool_call'
        ? displayValue(payload.input)
        : displayValue(payload.action ?? payload.arguments ?? payload.input ?? payload)
    return {
      id,
      role: 'tool',
      body,
      timestamp,
      toolId: callId,
      toolName: toolNames[type],
      toolPhase: 'call',
    }
  }

  if (outputTypes.has(type)) {
    return {
      id,
      role: 'tool',
      body: displayOutput(payload.output ?? payload.result ?? payload.tools ?? payload),
      timestamp,
      toolId: callId,
      toolName: string(payload.name) ?? 'tool',
      toolPhase: 'result',
    }
  }

  return undefined
}

function legacyEvent(payload: JsonObject, timestamp: string | undefined, id: string): ArchiveEvent | undefined {
  if (payload.type === 'user_message') {
    const body = string(payload.message) ?? textContent(payload.content)
    return body.trim() ? { id, role: 'user', body, timestamp } : undefined
  }
  if (payload.type === 'agent_message') {
    const body = string(payload.message) ?? textContent(payload.content)
    return body.trim() ? { id, role: 'assistant', body, timestamp } : undefined
  }
  return undefined
}

export async function parseCodexSession(
  sessionId: string,
  sources: SourceFile[],
  _options: ParseOptions,
): Promise<SessionArchive> {
  const events: ArchiveEvent[] = []
  const legacy: ArchiveEvent[] = []
  const diagnostics: ArchiveDiagnostic[] = []
  let project: string | undefined
  let startedAt: string | undefined
  let endedAt: string | undefined
  let sequence = 0

  for (const source of sources) {
    const issues = await visitStableJsonl(source.path, record => {
      const line = object(record.value)
      if (!line) return
      const timestamp = string(line.timestamp)
      if (timestamp) {
        startedAt = !startedAt || timestamp < startedAt ? timestamp : startedAt
        endedAt = !endedAt || timestamp > endedAt ? timestamp : endedAt
      }
      const payload = object(line.payload)
      if (!payload) return

      if (line.type === 'session_meta') {
        project ??= string(payload.cwd) ?? string(payload.project)
        return
      }

      const id = `codex-${sequence++}`
      const event = line.type === 'response_item'
        ? responseItemEvent(payload, timestamp, id)
        : line.type === 'event_msg'
          ? legacyEvent(payload, timestamp, id)
          : undefined
      if (!event) return

      if (line.type === 'event_msg') {
        legacy.push(event)
        return
      }
      events.push(event)
    })
    for (const issue of issues) {
      diagnostics.push({
        level: 'warning',
        code: 'INVALID_JSONL_LINE',
        message: `${basename(source.path)}:${issue.line} was skipped`,
      })
    }
  }

  if (!events.some(event => event.role === 'user' || event.role === 'assistant')) {
    events.push(...legacy)
  }

  return {
    provider: 'codex',
    sessionId,
    project,
    startedAt,
    endedAt,
    events,
    branches: [],
    sourceCount: sources.length,
    diagnostics,
  }
}
