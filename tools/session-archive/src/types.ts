export type Provider = 'codex' | 'claude'

export type ArchiveMode = 'full' | 'answers'

export type ArchiveRole = 'user' | 'assistant' | 'tool' | 'attachment' | 'notice'

export interface ArchiveEvent {
  id: string
  role: ArchiveRole
  body: string
  timestamp?: string
  label?: string
  toolId?: string
  toolName?: string
  toolPhase?: 'call' | 'result'
}

export interface ArchiveBranch {
  id: string
  label: string
  kind: 'alternate' | 'sidechain'
  events: ArchiveEvent[]
}

export interface ArchiveDiagnostic {
  level: 'warning' | 'error'
  code: string
  message: string
}

export interface SessionArchive {
  provider: Provider
  sessionId: string
  title?: string
  project?: string
  startedAt?: string
  endedAt?: string
  events: ArchiveEvent[]
  branches: ArchiveBranch[]
  sourceCount: number
  diagnostics: ArchiveDiagnostic[]
}

export interface ParseOptions {
  includeBranches: boolean
}

export interface SourceFile {
  path: string
  kind: 'main' | 'rollout' | 'subagent'
}
