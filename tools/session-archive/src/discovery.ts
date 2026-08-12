import { opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type { Provider, SourceFile } from './types.js'

export interface DiscoveryOptions {
  source?: string
  codexHome?: string
  claudeHome?: string
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function walkJsonl(root: string): Promise<string[]> {
  const pending = [root]
  const files: string[] = []

  while (pending.length > 0) {
    const current = pending.pop()!
    let dir
    try {
      dir = await opendir(current)
    } catch {
      continue
    }
    for await (const entry of dir) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }

  return files
}

async function discoverCodex(sessionId: string, options: DiscoveryOptions): Promise<SourceFile[]> {
  const root = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'))
  const roots = [join(root, 'sessions'), join(root, 'archived_sessions')]
  const files = (await Promise.all(roots.map(walkJsonl))).flat()
  const matching = files.filter(path => basename(path).includes(sessionId))
  const ranked = await Promise.all(
    matching.map(async path => ({ path, mtimeMs: (await stat(path)).mtimeMs })),
  )
  ranked.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
  return ranked.map(item => ({ path: item.path, kind: 'rollout' as const }))
}

async function discoverClaude(sessionId: string, options: DiscoveryOptions): Promise<SourceFile[]> {
  const root = resolve(options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
  const projectRoot = join(root, 'projects')
  const sources: SourceFile[] = []
  let projects
  try {
    projects = await opendir(projectRoot)
  } catch {
    return sources
  }
  for await (const project of projects) {
    if (!project.isDirectory()) continue
    const main = join(projectRoot, project.name, `${sessionId}.jsonl`)
    if (!(await isReadableFile(main))) continue
    sources.push({ path: main, kind: 'main' })
    const subagents = join(projectRoot, project.name, sessionId, 'subagents')
    for (const candidate of await walkJsonl(subagents)) {
      sources.push({ path: candidate, kind: 'subagent' })
    }
  }
  return sources
}

export async function discoverSources(
  provider: Provider,
  sessionId: string,
  options: DiscoveryOptions,
): Promise<SourceFile[]> {
  if (options.source) {
    const source = resolve(options.source)
    if (!(await isReadableFile(source))) throw new Error(`SOURCE_NOT_FOUND: ${source}`)
    return [{ path: source, kind: provider === 'claude' ? 'main' : 'rollout' }]
  }

  const sources = provider === 'codex'
    ? await discoverCodex(sessionId, options)
    : await discoverClaude(sessionId, options)
  if (sources.length === 0) throw new Error(`SESSION_NOT_FOUND: ${provider}:${sessionId}`)
  return sources
}
