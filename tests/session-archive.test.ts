import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { parseClaudeSession } from '../tools/session-archive/src/claude.ts'
import { parseArgs, run, writeAtomic } from '../tools/session-archive/src/cli.ts'
import { parseCodexSession } from '../tools/session-archive/src/codex.ts'
import { renderMarkdown } from '../tools/session-archive/src/markdown.ts'
import { sanitizeText } from '../tools/session-archive/src/privacy.ts'
import { readCodexThreadTitle } from '../tools/session-archive/src/title.ts'

async function fixture(lines: unknown[], name = 'session.jsonl'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tpl-session-archive-'))
  const path = join(dir, name)
  await writeFile(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return path
}

test('Codex parser exports visible messages and tools but excludes hidden reasoning', async () => {
  const path = await fixture([
    { timestamp: '2026-08-12T01:00:00Z', type: 'session_meta', payload: { id: 'codex-fixture', cwd: '/tmp/project' } },
    { timestamp: '2026-08-12T01:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nprivate developer policy\n</INSTRUCTIONS>' },
      { type: 'input_text', text: '<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>' },
    ] } },
    { timestamp: '2026-08-12T01:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'duplicate legacy prompt' } },
    { timestamp: '2026-08-12T01:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please inspect <script>alert(1)</script>' }] } },
    { timestamp: '2026-08-12T01:00:02Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'private chain of thought' }] } },
    { timestamp: '2026-08-12T01:00:03Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{"cmd":"pwd"}' } },
    { timestamp: '2026-08-12T01:00:04Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: '/tmp/project' } },
    { timestamp: '2026-08-12T01:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Finished.' }] } },
  ])

  const archive = await parseCodexSession(
    'codex-fixture',
    [{ path, kind: 'rollout' }],
    { includeBranches: true },
  )
  assert.deepEqual(archive.events.map(event => event.role), ['user', 'tool', 'tool', 'assistant'])
  assert.equal(archive.events.some(event => event.body.includes('private chain')), false)

  const rendered = renderMarkdown(archive, { generatedAt: '2026-08-12T02:00:00Z' })
  assert.match(rendered.markdown, /agent-provider: codex/)
  assert.match(rendered.markdown, /^## YOU · 2026-08-12 01:00:01Z$/m)
  assert.match(rendered.markdown, /^## CODEX Replying$/m)
  assert.match(rendered.markdown, /^#### TOOL · exec_command · CALL · 2026-08-12 01:00:03Z$/m)
  assert.match(rendered.markdown, /^#### TOOL · exec_command · RESULT · 2026-08-12 01:00:04Z$/m)
  assert.match(rendered.markdown, /^### CODEX Answered · 2026-08-12 01:00:05Z$/m)
  assert.match(rendered.markdown, /```text/)
  assert.match(rendered.markdown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(rendered.markdown, /private chain of thought/)
  assert.doesNotMatch(rendered.markdown, /private developer policy|environment_context/)
  assert.doesNotMatch(rendered.markdown, /duplicate legacy prompt/)
  assert.doesNotMatch(rendered.markdown, /<(?:details|h6|dl)\b/)
})

test('Codex contextual-envelope filtering does not remove a real prompt that merely mentions its marker', async () => {
  const path = await fixture([
    { timestamp: '2026-08-12T01:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please explain what <environment_context> means.' }] } },
  ])
  const archive = await parseCodexSession('context-mention', [{ path, kind: 'rollout' }], { includeBranches: true })
  assert.equal(archive.events[0]?.body, 'Please explain what <environment_context> means.')
})

test('answers mode keeps every prompt and final answer while omitting commentary and tools', async () => {
  const path = await fixture([
    { timestamp: '2026-08-12T01:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First prompt' }] } },
    { timestamp: '2026-08-12T01:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Working notes' }] } },
    { timestamp: '2026-08-12T01:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{"cmd":"pwd"}' } },
    { timestamp: '2026-08-12T01:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'First answer' }] } },
    { timestamp: '2026-08-12T01:01:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second prompt' }] } },
    { timestamp: '2026-08-12T01:01:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Second answer' }] } },
  ])
  const archive = await parseCodexSession('answers-fixture', [{ path, kind: 'rollout' }], { includeBranches: true })
  const rendered = renderMarkdown(archive, { mode: 'answers', generatedAt: '2026-08-12T02:00:00Z' })

  assert.equal((rendered.markdown.match(/^## YOU ·/gm) ?? []).length, 2)
  assert.equal((rendered.markdown.match(/^## CODEX Answered ·/gm) ?? []).length, 2)
  assert.match(rendered.markdown, /First prompt/)
  assert.match(rendered.markdown, /First answer/)
  assert.match(rendered.markdown, /Second prompt/)
  assert.match(rendered.markdown, /Second answer/)
  assert.doesNotMatch(rendered.markdown, /CODEX Replying|Working notes|TOOL ·|pwd/)
  assert.match(rendered.markdown, /agent-export-mode: answers/)
})

test('Codex parser preserves legitimately repeated visible messages', async () => {
  const repeated = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
  const path = await fixture([
    { timestamp: '2026-08-12T01:00:00Z', type: 'response_item', payload: repeated },
    { timestamp: '2026-08-12T01:00:01Z', type: 'response_item', payload: repeated },
  ])
  const archive = await parseCodexSession('repeat-fixture', [{ path, kind: 'rollout' }], { includeBranches: true })
  assert.deepEqual(archive.events.map(event => event.body), ['continue', 'continue'])
})

test('Codex parser keeps inter-agent text while omitting generated image payloads', async () => {
  const path = await fixture([
    { timestamp: '2026-08-12T01:00:00Z', type: 'response_item', payload: { type: 'agent_message', author: 'researcher', recipient: 'leader', content: [{ type: 'input_text', text: 'Primary-source evidence' }] } },
    { timestamp: '2026-08-12T01:00:01Z', type: 'response_item', payload: { type: 'image_generation_call', id: 'img-1', status: 'completed', revised_prompt: 'A quiet editorial page', result: 'SYNTHETIC_IMAGE_BYTES' } },
  ])
  const archive = await parseCodexSession('agent-fixture', [{ path, kind: 'rollout' }], { includeBranches: true })
  assert.match(archive.events[0]!.label!, /researcher.*leader/)
  assert.match(archive.events[1]!.body, /generated image payload omitted/)
  assert.doesNotMatch(archive.events[1]!.body, /SYNTHETIC_IMAGE_BYTES/)
})

test('Claude parser recovers the newest causal chain, alternates, tools, and sidechains', async () => {
  const path = await fixture([
    { type: 'ai-title', aiTitle: 'Generated title' },
    { type: 'custom-title', customTitle: 'My retained session title' },
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: '2026-08-12T01:00:00Z', cwd: '/tmp/project', message: { role: 'user', content: 'Build it' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, timestamp: '2026-08-12T01:00:01Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a.ts' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', isSidechain: false, timestamp: '2026-08-12T01:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }] } },
    { type: 'assistant', uuid: 'alt', parentUuid: 'u2', isSidechain: false, timestamp: '2026-08-12T01:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Older alternate' }] } },
    { type: 'assistant', uuid: 'main', parentUuid: 'u2', isSidechain: false, timestamp: '2026-08-12T01:00:04Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Primary result' }] } },
    { type: 'assistant', uuid: 'side', parentUuid: 'a1', isSidechain: true, agentId: 'researcher', timestamp: '2026-08-12T01:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Subagent evidence' }] } },
    { type: 'system', uuid: 'system', parentUuid: 'main', timestamp: '2026-08-12T01:00:06Z', content: 'private system prompt' },
  ])

  const archive = await parseClaudeSession(
    'claude-fixture',
    [{ path, kind: 'main' }],
    { includeBranches: true },
  )
  assert.equal(archive.events.some(event => event.body === 'Primary result'), true)
  assert.equal(archive.events.some(event => event.body === 'Older alternate'), false)
  assert.equal(archive.events.some(event => event.body.includes('hidden')), false)
  assert.equal(archive.branches.some(branch => branch.kind === 'alternate' && branch.events.some(event => event.body === 'Older alternate')), true)
  assert.equal(archive.branches.some(branch => branch.kind === 'sidechain' && branch.events.some(event => event.body === 'Subagent evidence')), true)
  assert.deepEqual(archive.events.filter(event => event.role === 'tool').map(event => event.toolPhase), ['call', 'result'])
  assert.equal(archive.title, 'My retained session title')
})

test('Codex title discovery prefers an explicit thread name and fails open without state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpl-session-title-'))
  const state = join(root, 'state_5.sqlite')
  const database = new DatabaseSync(state)
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT NOT NULL)')
  database.prepare('INSERT INTO threads (id, name, title) VALUES (?, ?, ?)')
    .run('018f0000-0000-7000-8000-000000000003', 'Pinned title', 'Generated title')
  database.close()

  assert.equal(
    await readCodexThreadTitle(root, '018f0000-0000-7000-8000-000000000003'),
    'Pinned title',
  )
  assert.equal(await readCodexThreadTitle(join(root, 'missing'), 'unknown'), undefined)
})

test('privacy pass redacts synthetic credentials, local home paths, and active URIs', () => {
  const fakeKey = ['sk', 'proj', 'SYNTHETIC0123456789abcdefghijkl'].join('-')
  const input = `${process.env.HOME}/notes\nAuthorization: Bearer abc.def.ghi\n${fakeKey}\n[x](javascript:alert(1))\n![pixel](https://tracker.invalid/p.gif)\n<img src=x>`
  const result = sanitizeText(input)
  assert.ok(result.redactions >= 3)
  assert.doesNotMatch(result.text, new RegExp(fakeKey))
  assert.doesNotMatch(result.text, /javascript:/i)
  assert.match(result.text, /\\!\[pixel\]/)
  assert.match(result.text, /&lt;img src=x&gt;/)
  assert.doesNotMatch(result.text, new RegExp(process.env.HOME!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('CLI discovers a Codex rollout and publishes a private atomic Markdown file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpl-session-cli-'))
  const sessionId = '018f0000-0000-7000-8000-000000000001'
  const sessions = join(root, 'sessions', '2026', '08', '12')
  await mkdir(sessions, { recursive: true })
  const rollout = join(sessions, `rollout-2026-08-12T00-00-00-${sessionId}.jsonl`)
  await writeFile(rollout, `${JSON.stringify({ timestamp: '2026-08-12T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Archive this' }] } })}\n`, 'utf8')
  const database = new DatabaseSync(join(root, 'state_5.sqlite'))
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT NOT NULL)')
  database.prepare('INSERT INTO threads (id, name, title) VALUES (?, ?, ?)')
    .run(sessionId, null, 'Stored Codex session title')
  database.close()
  const output = join(root, 'notes', 'archive.md')

  assert.equal(await run(['codex', sessionId, '--codex-home', root, '--output', output]), 0)
  const markdown = await readFile(output, 'utf8')
  assert.match(markdown, /^# Stored Codex session title$/m)
  assert.match(markdown, /Archive this/)
  assert.equal((await stat(output)).mode & 0o777, 0o600)
  assert.equal(await run(['codex', sessionId, '--codex-home', root, '--output', output]), 4)
})

test('CLI directory output splits a large archive into private navigable Markdown parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpl-session-split-'))
  const sessionId = '018f0000-0000-7000-8000-000000000004'
  const sessions = join(root, 'sessions', '2026', '08', '12')
  await mkdir(sessions, { recursive: true })
  const rollout = join(sessions, `rollout-2026-08-12T00-00-00-${sessionId}.jsonl`)
  const largeResult = 'evidence '.repeat(13_000)
  const lines = [
    { timestamp: '2026-08-12T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Archive a large session' }] } },
    { timestamp: '2026-08-12T00:00:01Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{"cmd":"collect"}' } },
    { timestamp: '2026-08-12T00:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: largeResult } },
    { timestamp: '2026-08-12T00:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Large archive finished' }] } },
  ]
  await writeFile(rollout, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  const outputDir = join(root, 'notes')

  assert.equal(await run([
    'codex', sessionId,
    '--codex-home', root,
    '--output-dir', outputDir,
    '--max-file-size', '64KiB',
  ]), 0)

  const archiveDir = join(outputDir, `codex-session-${sessionId}`)
  const names = (await readdir(archiveDir)).sort()
  assert.equal(names[0], 'index.md')
  assert.ok(names.filter(name => /^part-\d+\.md$/.test(name)).length >= 2)
  const index = await readFile(join(archiveDir, 'index.md'), 'utf8')
  assert.match(index, /\[Part 1 ·/)
  for (const name of names) {
    const path = join(archiveDir, name)
    assert.ok((await stat(path)).size <= 64 * 1024, `${name} exceeds the configured limit`)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    if (name.startsWith('part-')) {
      const markdown = await readFile(path, 'utf8')
      assert.equal((markdown.match(/^```/gm) ?? []).length % 2, 0, `${name} has an unbalanced fence`)
      assert.match(markdown, /\[Archive index\]\(index\.md\)/)
    }
  }

  const compactArgs = [
    'codex', sessionId,
    '--codex-home', root,
    '--output-dir', outputDir,
    '--mode', 'answers',
    '--max-file-size', '64KiB',
  ]
  assert.equal(await run(compactArgs), 4, 'the alternate split target must still honor no-clobber')
  assert.equal(await run([...compactArgs, '--force']), 0)
  const compact = await readFile(join(outputDir, `codex-session-${sessionId}.md`), 'utf8')
  assert.match(compact, /Large archive finished/)
  await assert.rejects(readdir(archiveDir), /ENOENT/, 'force publication must not leave stale split parts')
})

test('CLI answers-only directory output stays compact and excludes oversized tool evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpl-session-answers-cli-'))
  const sessionId = '018f0000-0000-7000-8000-000000000005'
  const source = await fixture([
    { timestamp: '2026-08-12T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep only the answer' }] } },
    { timestamp: '2026-08-12T00:00:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'private evidence '.repeat(8_000) } },
    { timestamp: '2026-08-12T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'The retained answer' }] } },
  ])
  const outputDir = join(root, 'notes')

  assert.equal(await run([
    'codex', sessionId,
    '--source', source,
    '--output-dir', outputDir,
    '--mode', 'answers',
    '--max-file-size', '64KiB',
  ]), 0)

  const output = join(outputDir, `codex-session-${sessionId}.md`)
  const markdown = await readFile(output, 'utf8')
  assert.match(markdown, /Keep only the answer/)
  assert.match(markdown, /The retained answer/)
  assert.doesNotMatch(markdown, /private evidence|TOOL ·|CODEX Replying/)
  assert.ok((await stat(output)).size < 64 * 1024)
})

test('CLI discovers a Claude main transcript and its subagent appendix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpl-session-claude-cli-'))
  const sessionId = '018f0000-0000-7000-8000-000000000002'
  const project = join(root, 'projects', '-tmp-project')
  const subagents = join(project, sessionId, 'subagents')
  await mkdir(subagents, { recursive: true })
  await writeFile(
    join(project, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: '2026-08-12T00:00:00Z', message: { role: 'user', content: 'Main prompt' } })}\n`,
    'utf8',
  )
  await writeFile(
    join(subagents, 'agent-researcher.jsonl'),
    `${JSON.stringify({ type: 'assistant', uuid: 's1', parentUuid: null, isSidechain: true, agentId: 'researcher', timestamp: '2026-08-12T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Subagent result' }] } })}\n`,
    'utf8',
  )
  const output = join(root, 'archive.md')
  assert.equal(await run(['claude', sessionId, '--claude-home', root, '-o', output]), 0)
  const markdown = await readFile(output, 'utf8')
  assert.match(markdown, /Main prompt/)
  assert.match(markdown, /Subagent result/)
  assert.match(markdown, /Recovered branches/)
})

test('atomic writer leaves an existing file untouched unless force is explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpl-session-atomic-'))
  const output = join(root, 'note.md')
  await writeFile(output, 'original', 'utf8')
  await chmod(output, 0o644)
  await assert.rejects(writeAtomic(output, 'replacement', false), /OUTPUT_EXISTS/)
  assert.equal(await readFile(output, 'utf8'), 'original')
  await writeAtomic(output, 'replacement', true)
  assert.equal(await readFile(output, 'utf8'), 'replacement')
  assert.equal((await stat(output)).mode & 0o777, 0o600)
})

test('CLI argument parser keeps provider/source/output contracts explicit', () => {
  assert.deepEqual(parseArgs(['claude', 'abcdef', '--main-only', '-o', '-']), {
    provider: 'claude',
    sessionId: 'abcdef',
    output: '-',
    includeBranches: false,
    force: false,
    help: false,
  })
  assert.throws(() => parseArgs(['unknown', 'abcdef']), /UNKNOWN_PROVIDER/)
  assert.deepEqual(
    parseArgs(['codex', 'abcdef', '--output-dir', 'notes', '--mode', 'answers', '--max-file-size', '4MiB']),
    {
      provider: 'codex',
      sessionId: 'abcdef',
      outputDir: 'notes',
      mode: 'answers',
      maxFileBytes: 4 * 1024 * 1024,
      includeBranches: true,
      force: false,
      help: false,
    },
  )
  assert.throws(() => parseArgs(['codex', 'abcdef', '-o', 'a.md', '--output-dir', 'notes']), /OUTPUT_CONFLICT/)
  assert.throws(() => parseArgs(['codex', 'abcdef', '--mode', 'everything']), /UNKNOWN_MODE/)
  assert.throws(() => parseArgs(['codex', 'abcdef', '--max-file-size', '12nope']), /INVALID_SIZE/)
  assert.throws(
    () => parseArgs(['codex', 'abcdef', '--output-dir', 'notes', '--max-file-size', '32KiB']),
    /MAX_FILE_SIZE_TOO_SMALL/,
  )
})
