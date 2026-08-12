import { constants } from 'node:fs'
import {
  access,
  chmod,
  link,
  mkdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
  renderArchiveDocument,
  type MarkdownBlock,
  type RenderedArchive,
} from './markdown.js'

export interface PublicationResult {
  destination: string
  files: string[]
  split: boolean
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
      await link(temporary, destination)
      await rm(temporary)
    } else {
      try {
        await rename(temporary, destination)
      } catch (error) {
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

function bytes(value: string): number {
  return Buffer.byteLength(value)
}

function partitionBlocks(rendered: RenderedArchive, maxFileBytes: number): MarkdownBlock[][] {
  // Every part repeats private metadata and navigation. Reserving 16 KiB makes
  // the final byte limit an invariant even when titles use multi-byte text.
  const blockBudget = maxFileBytes - 16 * 1024
  if (blockBudget < 16 * 1024) throw new Error('MAX_FILE_SIZE_TOO_SMALL: use at least 64KiB')
  const parts: MarkdownBlock[][] = []
  let current: MarkdownBlock[] = []
  let currentBytes = 0

  for (const block of rendered.blocks) {
    const blockBytes = bytes(block.markdown) + 2
    const firstBlockBytes = blockBytes + (block.continuation ? bytes(block.continuation) + 2 : 0)
    if (firstBlockBytes > blockBudget) {
      throw new Error(`ARCHIVE_BLOCK_TOO_LARGE: ${block.label}`)
    }
    if (current.length > 0 && currentBytes + blockBytes > blockBudget) {
      parts.push(current)
      current = []
      currentBytes = 0
    }
    current.push(block)
    currentBytes += current.length === 1 ? firstBlockBytes : blockBytes
  }
  if (current.length > 0) parts.push(current)
  return parts.length > 0 ? parts : [[]]
}

function partName(index: number, total: number): string {
  const digits = Math.max(2, String(total).length)
  return `part-${String(index).padStart(digits, '0')}.md`
}

function renderIndex(rendered: RenderedArchive, parts: MarkdownBlock[][]): string {
  const links = parts.map((blocks, index) => {
    const label = blocks[0]?.label ?? 'Empty archive'
    return `- [Part ${index + 1} · ${label}](${partName(index + 1, parts.length)})`
  })
  return [
    '---',
    'agent-session: 2',
    `agent-provider: ${rendered.archive.provider}`,
    `agent-session-id: ${JSON.stringify(rendered.archive.sessionId)}`,
    `agent-exported-at: ${JSON.stringify(rendered.generatedAt)}`,
    `agent-export-mode: ${rendered.mode}`,
    `agent-source-count: ${rendered.archive.sourceCount}`,
    `agent-redactions: ${rendered.redactions}`,
    `agent-session-parts: ${parts.length}`,
    '---',
    '',
    '`SESSION ARCHIVE · INDEX`',
    '',
    `# ${rendered.title.replace(/[\\*`[\]]/g, '\\$&')}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Agent | ${rendered.providerName} |`,
    `| Session | \`${rendered.archive.sessionId}\` |`,
    `| Export | ${rendered.mode === 'answers' ? 'Prompts and final answers' : 'Full visible transcript'} |`,
    `| Parts | ${parts.length} |`,
    '',
    '## Archive parts',
    '',
    ...links,
    '',
    '*Open one part at a time in Typora. Each part stays below the configured size limit.*',
    '',
  ].join('\n')
}

async function publishDirectory(
  destination: string,
  files: Map<string, string>,
  force: boolean,
): Promise<void> {
  const parent = dirname(destination)
  await mkdir(parent, { recursive: true })
  if (!force && await exists(destination)) throw new Error(`OUTPUT_EXISTS: ${destination}`)
  const nonce = `${process.pid}-${Date.now()}`
  const targetName = basename(destination)
  const staging = join(parent, `.${targetName}.tmp-${nonce}`)
  const backup = join(parent, `.${targetName}.backup-${nonce}`)
  let previousMoved = false
  let newPublished = false
  await mkdir(staging, { mode: 0o700 })
  await chmod(staging, 0o700)
  try {
    for (const [name, content] of files) {
      const path = join(staging, name)
      await writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await chmod(path, 0o600)
    }
    if (force && await exists(destination)) {
      await rename(destination, backup)
      previousMoved = true
      await rename(staging, destination)
      newPublished = true
      await rm(backup, { recursive: true, force: true })
      previousMoved = false
    } else {
      await rename(staging, destination)
      newPublished = true
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (previousMoved) {
      try {
        if (newPublished) await rm(destination, { recursive: true, force: true })
        await rename(backup, destination)
        previousMoved = false
      } catch (rollbackError) {
        throw new Error(
          `OUTPUT_ROLLBACK_FAILED: previous output preserved at ${backup}`,
          { cause: rollbackError },
        )
      }
    }
    throw error
  }
}

export async function publishArchive(
  outputDir: string,
  baseName: string,
  rendered: RenderedArchive,
  maxFileBytes: number,
  force: boolean,
): Promise<PublicationResult> {
  const root = resolve(outputDir)
  const singleDestination = join(root, `${baseName}.md`)
  const splitDestination = join(root, baseName)
  if (bytes(rendered.markdown) <= maxFileBytes) {
    if (await exists(splitDestination) && !force) {
      throw new Error(`OUTPUT_EXISTS: ${splitDestination}`)
    }
    await writeAtomic(singleDestination, rendered.markdown, force)
    if (force) await rm(splitDestination, { recursive: true, force: true })
    return { destination: singleDestination, files: [singleDestination], split: false }
  }

  const parts = partitionBlocks(rendered, maxFileBytes)
  const files = new Map<string, string>()
  const index = renderIndex(rendered, parts)
  if (bytes(index) > maxFileBytes) throw new Error('ARCHIVE_INDEX_TOO_LARGE: increase --max-file-size')
  files.set('index.md', index)
  parts.forEach((blocks, offset) => {
    const index = offset + 1
    const name = partName(index, parts.length)
    const markdown = renderArchiveDocument(rendered, blocks, {
      index,
      total: parts.length,
      indexHref: 'index.md',
      previous: index > 1 ? partName(index - 1, parts.length) : undefined,
      next: index < parts.length ? partName(index + 1, parts.length) : undefined,
    })
    if (bytes(markdown) > maxFileBytes) {
      throw new Error(`ARCHIVE_PART_TOO_LARGE: ${name}`)
    }
    files.set(name, markdown)
  })

  if (await exists(singleDestination) && !force) {
    throw new Error(`OUTPUT_EXISTS: ${singleDestination}`)
  }
  await publishDirectory(splitDestination, files, force)
  if (force) await rm(singleDestination, { force: true })
  return {
    destination: splitDestination,
    files: [...files.keys()].map(name => join(splitDestination, name)),
    split: true,
  }
}
