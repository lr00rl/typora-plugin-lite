import { constants } from 'node:fs'
import { access, chmod, link, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseClaudeSession } from './claude.js'
import { parseCodexSession } from './codex.js'
import { discoverSources } from './discovery.js'
import { renderMarkdown } from './markdown.js'
import type { Provider } from './types.js'

interface CliOptions {
  provider?: Provider
  sessionId?: string
  output?: string
  source?: string
  title?: string
  codexHome?: string
  claudeHome?: string
  includeBranches: boolean
  force: boolean
  help: boolean
}

const HELP = `session-archive — export Codex or Claude Code history to a Typora note

Usage:
  session-archive <codex|claude> <session-id> [options]

Options:
  -o, --output <file>       Destination Markdown file (use - for stdout)
      --source <jsonl>      Read one explicit transcript instead of discovery
      --title <text>        Override the note title
      --codex-home <dir>    Override CODEX_HOME for discovery
      --claude-home <dir>   Override CLAUDE_CONFIG_DIR for discovery
      --main-only           Omit Claude alternate branches and subagents
  -f, --force               Replace an existing output file atomically
  -h, --help                Show this help

Privacy defaults:
  Local home paths, high-confidence credentials, private keys, and active HTML
  are redacted or neutralized. Hidden reasoning and instruction messages are
  never exported.
`

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
    else if (arg === '-o' || arg === '--output') options.output = valueAfter(args, index++, arg)
    else if (arg === '--source') options.source = valueAfter(args, index++, arg)
    else if (arg === '--title') options.title = valueAfter(args, index++, arg)
    else if (arg === '--codex-home') options.codexHome = valueAfter(args, index++, arg)
    else if (arg === '--claude-home') options.claudeHome = valueAfter(args, index++, arg)
    else if (arg.startsWith('-')) throw new Error(`UNKNOWN_OPTION: ${arg}`)
    else positional.push(arg)
  }
  if (positional[0] === 'codex' || positional[0] === 'claude') options.provider = positional[0]
  else if (positional[0]) throw new Error(`UNKNOWN_PROVIDER: ${positional[0]}`)
  options.sessionId = positional[1]
  if (positional.length > 2) throw new Error(`UNEXPECTED_ARGUMENT: ${positional[2]}`)
  return options
}

function defaultOutput(provider: Provider, sessionId: string): string {
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)
  return resolve(`${provider}-session-${safeId}.md`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function writeAtomic(path: string, content: string, force: boolean): Promise<void> {
  const destination = resolve(path)
  if (!force && await exists(destination)) throw new Error(`OUTPUT_EXISTS: ${destination}`)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    if (!force) {
      // A same-filesystem hard link is an atomic no-clobber publication: if a
      // competing process creates the destination after our preflight check,
      // link() fails with EEXIST and their file remains untouched.
      await link(temporary, destination)
      await rm(temporary)
    } else {
      try {
        await rename(temporary, destination)
      } catch (error) {
        // Windows cannot replace an existing path with rename(). Keep the
        // less-strong fallback platform-specific; POSIX stays fully atomic.
        if (process.platform !== 'win32' || !(await exists(destination))) throw error
        await rm(destination)
        await rename(temporary, destination)
      }
    }
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
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
    const rendered = renderMarkdown(archive, { title: options.title })
    const output = options.output ?? defaultOutput(options.provider, options.sessionId)
    if (output === '-') process.stdout.write(rendered.markdown)
    else await writeAtomic(output, rendered.markdown, options.force)

    for (const diagnostic of archive.diagnostics) {
      process.stderr.write(`[${diagnostic.level}] ${diagnostic.code}: ${diagnostic.message}\n`)
    }
    if (output !== '-') {
      process.stderr.write(
        `Archived ${archive.events.length} main events` +
        `${archive.branches.length ? ` and ${archive.branches.length} recovered branches` : ''}` +
        ` to ${basename(output)}; ${rendered.redactions} redactions.\n`,
      )
    }
    const visibleEvents = archive.events.length
      + archive.branches.reduce((sum, branch) => sum + branch.events.length, 0)
    return visibleEvents > 0 ? 0 : 5
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
