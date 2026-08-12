import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseClaudeSession } from './claude.js'
import { parseCodexSession } from './codex.js'
import { discoverSources } from './discovery.js'
import { renderMarkdown } from './markdown.js'
import { publishArchive, writeAtomic } from './publication.js'
import { readCodexThreadTitle } from './title.js'
import type { ArchiveMode, Provider } from './types.js'

export { writeAtomic } from './publication.js'

interface CliOptions {
  provider?: Provider
  sessionId?: string
  output?: string
  outputDir?: string
  source?: string
  title?: string
  codexHome?: string
  codexSqliteHome?: string
  claudeHome?: string
  mode?: ArchiveMode
  maxFileBytes?: number
  includeBranches: boolean
  force: boolean
  help: boolean
}

const HELP = `session-archive — export Codex or Claude Code history to a Typora note

Usage:
  session-archive <codex|claude> <session-id> [options]

Options:
  -o, --output <file>       Destination Markdown file (use - for stdout)
      --output-dir <dir>    Publish one note or a size-limited part directory
      --max-file-size <n>   Per-file limit for --output-dir (default: 4MiB)
      --mode <full|answers> Include all visible events or prompts/final answers
      --answers-only        Alias for --mode answers
      --source <jsonl>      Read one explicit transcript instead of discovery
      --title <text>        Override the note title
      --codex-home <dir>    Override CODEX_HOME for discovery
      --codex-sqlite-home <dir>
                             Override CODEX_SQLITE_HOME for title discovery
      --claude-home <dir>   Override CLAUDE_CONFIG_DIR for discovery
      --main-only           Omit Claude alternate branches and subagents
  -f, --force               Safely replace an existing output target
  -h, --help                Show this help

Privacy defaults:
  Local home paths, high-confidence credentials, private keys, and active HTML
  are redacted or neutralized. Hidden reasoning and instruction messages are
  never exported.
`

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024
const MIN_MAX_FILE_BYTES = 64 * 1024

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || (value.startsWith('-') && value !== '-')) throw new Error(`MISSING_VALUE: ${flag}`)
  return value
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { includeBranches: true, force: false, help: false }
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '-f' || arg === '--force') options.force = true
    else if (arg === '--main-only') options.includeBranches = false
    else if (arg === '--answers-only') options.mode = 'answers'
    else if (arg === '-o' || arg === '--output') options.output = valueAfter(args, index++, arg)
    else if (arg === '--output-dir') options.outputDir = valueAfter(args, index++, arg)
    else if (arg === '--max-file-size') options.maxFileBytes = parseByteSize(valueAfter(args, index++, arg))
    else if (arg === '--mode') {
      const mode = valueAfter(args, index++, arg)
      if (mode !== 'full' && mode !== 'answers') throw new Error(`UNKNOWN_MODE: ${mode}`)
      options.mode = mode
    }
    else if (arg === '--source') options.source = valueAfter(args, index++, arg)
    else if (arg === '--title') options.title = valueAfter(args, index++, arg)
    else if (arg === '--codex-home') options.codexHome = valueAfter(args, index++, arg)
    else if (arg === '--codex-sqlite-home') options.codexSqliteHome = valueAfter(args, index++, arg)
    else if (arg === '--claude-home') options.claudeHome = valueAfter(args, index++, arg)
    else if (arg.startsWith('-')) throw new Error(`UNKNOWN_OPTION: ${arg}`)
    else positional.push(arg)
  }
  if (positional[0] === 'codex' || positional[0] === 'claude') options.provider = positional[0]
  else if (positional[0]) throw new Error(`UNKNOWN_PROVIDER: ${positional[0]}`)
  options.sessionId = positional[1]
  if (positional.length > 2) throw new Error(`UNEXPECTED_ARGUMENT: ${positional[2]}`)
  if (options.output && options.outputDir) throw new Error('OUTPUT_CONFLICT: use --output or --output-dir, not both')
  if (options.maxFileBytes !== undefined && !options.outputDir) {
    throw new Error('MAX_SIZE_REQUIRES_OUTPUT_DIR: --max-file-size is only valid with --output-dir')
  }
  if (options.maxFileBytes !== undefined && options.maxFileBytes < MIN_MAX_FILE_BYTES) {
    throw new Error('MAX_FILE_SIZE_TOO_SMALL: use at least 64KiB')
  }
  return options
}

function parseByteSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(value.trim())
  if (!match) throw new Error(`INVALID_SIZE: ${value}`)
  const amount = Number(match[1])
  const factors: Record<string, number> = {
    b: 1,
    kb: 1_000,
    kib: 1_024,
    mb: 1_000_000,
    mib: 1_048_576,
    gb: 1_000_000_000,
    gib: 1_073_741_824,
  }
  const bytes = Math.floor(amount * factors[(match[2] ?? 'b').toLowerCase()]!)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`INVALID_SIZE: ${value}`)
  return bytes
}

function defaultOutput(provider: Provider, sessionId: string): string {
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)
  return resolve(`${provider}-session-${safeId}.md`)
}

function archiveBaseName(provider: Provider, sessionId: string): string {
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)
  return `${provider}-session-${safeId}`
}

export async function run(args: string[]): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(args)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (!options.provider || !options.sessionId) {
    process.stderr.write(`Provider and session ID are required.\n\n${HELP}`)
    return 2
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(options.sessionId)) {
    process.stderr.write('Session ID contains unsupported characters or is too short.\n')
    return 2
  }

  try {
    const discovered = await discoverSources(options.provider, options.sessionId, options)
    const sources = options.includeBranches
      ? discovered
      : discovered.filter(source => source.kind !== 'subagent')
    const archive = options.provider === 'codex'
      ? await parseCodexSession(options.sessionId, sources, options)
      : await parseClaudeSession(options.sessionId, sources, options)
    if (options.provider === 'codex' && !options.title) {
      const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
      const sqliteHome = options.codexSqliteHome ?? process.env.CODEX_SQLITE_HOME ?? codexHome
      archive.title = await readCodexThreadTitle(sqliteHome, options.sessionId) ?? archive.title
    }
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    const rendered = renderMarkdown(archive, {
      title: options.title,
      mode: options.mode,
      maxBodyBytes: options.outputDir ? Math.floor(maxFileBytes / 2) : undefined,
    })
    const output = options.output ?? (options.outputDir ? undefined : defaultOutput(options.provider, options.sessionId))
    const publication = options.outputDir
      ? await publishArchive(
        options.outputDir,
        archiveBaseName(options.provider, options.sessionId),
        rendered,
        maxFileBytes,
        options.force,
      )
      : undefined
    if (output === '-') process.stdout.write(rendered.markdown)
    else if (output) await writeAtomic(output, rendered.markdown, options.force)

    for (const diagnostic of archive.diagnostics) {
      process.stderr.write(`[${diagnostic.level}] ${diagnostic.code}: ${diagnostic.message}\n`)
    }
    if (output !== '-') {
      const destination = publication?.destination ?? output!
      const fileSummary = publication?.split
        ? `${publication.files.length - 1} size-limited parts plus index`
        : 'one Markdown file'
      const promptCount = archive.events.filter(event => event.role === 'user').length
      const mainSummary = rendered.mode === 'answers'
        ? `${promptCount} prompt${promptCount === 1 ? '' : 's'} and final answer${promptCount === 1 ? '' : 's'}`
        : `${archive.events.length} visible main event${archive.events.length === 1 ? '' : 's'}`
      const branchCount = rendered.mode === 'full' ? archive.branches.length : 0
      process.stderr.write(
        `Archived ${mainSummary}` +
        `${branchCount ? ` and ${branchCount} recovered branch${branchCount === 1 ? '' : 'es'}` : ''}` +
        ` to ${basename(destination)} (${fileSummary}, ${rendered.mode} mode); ` +
        `${rendered.redactions} redactions.\n`,
      )
    }
    return rendered.blocks.length > 0 ? 0 : 5
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    if (message.startsWith('SESSION_NOT_FOUND') || message.startsWith('SOURCE_NOT_FOUND')) return 3
    return 4
  }
}

declare const __SESSION_ARCHIVE_BUNDLED__: boolean | undefined

const isBundled = typeof __SESSION_ARCHIVE_BUNDLED__ !== 'undefined' && __SESSION_ARCHIVE_BUNDLED__
const isEntrypoint = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false
if (isBundled || isEntrypoint) {
  process.exitCode = await run(process.argv.slice(2))
}
