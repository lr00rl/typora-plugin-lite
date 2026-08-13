import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import * as nodePath from 'node:path'
import { Window } from 'happy-dom'

const dom = new Window({ url: 'https://localhost/' })
Object.defineProperty(dom, 'reqnode', {
  value: (name: string) => name === 'path' ? nodePath : undefined,
  configurable: true,
})
for (const name of ['window', 'document', 'HTMLElement', 'navigator'] as const) {
  Object.defineProperty(globalThis, name, {
    value: (dom as any)[name] ?? (dom.document as any)[name],
    configurable: true,
    writable: true,
  })
}
const { platform } = await import('../packages/core/src/index.ts')
const { default: QuickOpenPlugin } = await import('../plugins/fuzzy-search/src/main.ts')

after(() => dom.close())

function matchEvent(path: string, line: number, text: string, term = 'alpha'): string {
  const start = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase())
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: line,
      absolute_offset: 0,
      submatches: [{ match: { text: term }, start, end: start + term.length }],
    },
  })
}

test('content search uses compact candidate discovery, bounded excerpts, and a short cache', async () => {
  const plugin = new QuickOpenPlugin() as any
  plugin.rgPath = '/opt/homebrew/bin/rg'
  plugin.getRootDir = () => '/vault'
  plugin.getIndexCacheDir = () => '/cache/fuzzy-search'

  const originalRun = platform.shell.run
  const originalReadText = platform.fs.readText
  const originalRemove = platform.fs.remove
  const commands: string[] = []
  platform.shell.run = async (command: string) => {
    commands.push(command)
    return ''
  }
  platform.fs.readText = async (path: string) => {
    if (path.includes('content-counts-')) {
      return '/vault/notes/a.md:8\n/vault/notes/b.md:2\n'
    }
    return [
      matchEvent('/vault/notes/a.md', 12, 'alpha beta is the strongest result'),
      matchEvent('/vault/notes/b.md', 4, 'alpha only'),
    ].join('\n')
  }
  platform.fs.remove = async () => {}

  try {
    const first = await plugin.searchContent('alpha beta', '', 100)
    assert.equal(commands.length, 2)
    assert.match(commands[0]!, /--count-matches/)
    assert.match(commands[0]!, /--max-count 12/)
    assert.match(commands[0]!, /--iglob '\*\.md'/)
    assert.match(commands[0]!, /umask 077/)
    assert.match(commands[0]!, /> '[^']+\.tmp'/)
    assert.doesNotMatch(commands[0]!, /--json/)
    assert.match(commands[1]!, /--json/)
    assert.match(commands[1]!, /--context 1/)
    assert.match(commands[1]!, /--max-count 3/)
    assert.match(commands[1]!, /umask 077/)
    assert.match(commands[1]!, /> '[^']+\.tmp'/)
    assert.deepEqual(first.matches.map((match: { relPath: string }) => match.relPath), ['notes/a.md'])
    assert.equal(first.matchingFileCount, 2)
    assert.equal(first.candidateSetTruncated, false)

    const cached = await plugin.searchContent('alpha beta', '', 100)
    assert.equal(cached, first)
    assert.equal(commands.length, 2, 'identical searches reuse the recent ranked result')
  } finally {
    platform.shell.run = originalRun
    platform.fs.readText = originalReadText
    platform.fs.remove = originalRemove
  }
})

test('content search propagates real ripgrep failures instead of presenting a false empty result', async () => {
  const plugin = new QuickOpenPlugin() as any
  plugin.rgPath = '/opt/homebrew/bin/rg'
  plugin.getRootDir = () => '/vault'
  plugin.getIndexCacheDir = () => '/cache/fuzzy-search'

  const originalRun = platform.shell.run
  const originalRemove = platform.fs.remove
  platform.shell.run = async () => { throw new Error('permission denied') }
  platform.fs.remove = async () => {}
  try {
    await assert.rejects(
      plugin.searchContent('alpha', '', 100),
      /permission denied/,
    )
  } finally {
    platform.shell.run = originalRun
    platform.fs.remove = originalRemove
  }
})

test('content excerpts spill to a private temp file instead of crossing the command bridge', async () => {
  const plugin = new QuickOpenPlugin() as any
  plugin.rgPath = '/opt/homebrew/bin/rg'
  plugin.getRootDir = () => '/vault'
  plugin.getIndexCacheDir = () => '/cache/fuzzy-search'

  const originalRun = platform.shell.run
  const originalReadText = platform.fs.readText
  const originalRemove = platform.fs.remove
  const commands: string[] = []
  const readPaths: string[] = []
  const removedPaths: string[] = []
  platform.shell.run = async (command: string) => {
    commands.push(command)
    return ''
  }
  platform.fs.readText = async (path: string) => {
    readPaths.push(path)
    if (path.includes('content-counts-')) {
      return Array.from({ length: 45 }, (_, index) => (
        `/vault/notes/file-${String(index).padStart(2, '0')}.md:1`
      )).join('\n')
    }
    return ''
  }
  platform.fs.remove = async (path: string) => { removedPaths.push(path) }

  try {
    const result = await plugin.searchContent('alpha', '', 100)
    assert.equal(commands.length, 2, 'the bridge receives one count command and one output-free excerpt command')
    assert.match(commands[1]!, /--json/)
    assert.match(commands[1]!, /umask 077/)
    assert.match(commands[1]!, /file-00\.md/)
    assert.match(commands[1]!, /file-44\.md/)
    assert.equal(readPaths.length, 2)
    assert.deepEqual(removedPaths, readPaths, 'temporary content is removed after the dedicated file read')
    assert.equal(result.inspectedFileCount, 45)
  } finally {
    platform.shell.run = originalRun
    platform.fs.readText = originalReadText
    platform.fs.remove = originalRemove
  }
})

test('content searches serialize bridge work and obsolete searches stop before excerpts', async () => {
  const plugin = new QuickOpenPlugin() as any
  plugin.rgPath = '/opt/homebrew/bin/rg'
  plugin.getRootDir = () => '/vault'
  plugin.getIndexCacheDir = () => '/cache/fuzzy-search'

  const originalRun = platform.shell.run
  const originalReadText = platform.fs.readText
  const originalRemove = platform.fs.remove
  const commands: string[] = []
  let releaseFirstCount!: (stdout: string) => void
  let firstObsolete = false
  platform.shell.run = async (command: string) => {
    commands.push(command)
    if (commands.length === 1) {
      return await new Promise<string>(resolve => { releaseFirstCount = resolve })
    }
    return ''
  }
  platform.fs.readText = async (path: string) => path.includes('content-counts-')
    ? '/vault/notes/beta.md:1\n'
    : matchEvent('/vault/notes/beta.md', 4, 'beta is current', 'beta')
  platform.fs.remove = async () => {}

  try {
    const obsolete = plugin.searchContent('alpha', '', 100, () => firstObsolete)
    await new Promise(resolve => setTimeout(resolve, 0))
    const current = plugin.searchContent('beta', '', 100, () => false)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(commands.length, 1, 'the newer request waits instead of flooding the Typora bridge')

    firstObsolete = true
    releaseFirstCount('/vault/notes/alpha.md:1\n')
    const obsoleteResult = await obsolete
    const currentResult = await current

    assert.equal(obsoleteResult.matches.length, 0)
    assert.equal(commands.length, 3, 'obsolete work skips excerpts; the current query gets count + excerpt')
    assert.equal(currentResult.matches[0]?.basename, 'beta.md')
  } finally {
    platform.shell.run = originalRun
    platform.fs.readText = originalReadText
    platform.fs.remove = originalRemove
  }
})

test('content error rendering uses safe actionable copy instead of the raw shell failure', async () => {
  const plugin = new QuickOpenPlugin() as any
  const list = document.createElement('div')
  const footer = document.createElement('div')
  plugin.listEl = list
  plugin.footerTextEl = footer
  plugin.rgPath = '/opt/homebrew/bin/rg'
  plugin.renderToken = 9
  plugin.warn = () => {}
  plugin.searchContent = async () => {
    throw new Error("Shell timeout: rg --json '/Users/private/vault/secret.md'")
  }

  await plugin.runSearch(list, 9, 'content', '', 'quick')

  assert.match(list.textContent ?? '', /内容搜索超时/)
  assert.match(list.textContent ?? '', /scope:/)
  assert.doesNotMatch(list.textContent ?? '', /\/Users\/private|secret\.md|rg --json/)
  assert.equal(footer.textContent, '内容搜索超时')
})
