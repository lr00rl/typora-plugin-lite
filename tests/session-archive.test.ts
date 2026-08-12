import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseClaudeSession } from '../tools/session-archive/src/claude.ts'
import { parseArgs, run, writeAtomic } from '../tools/session-archive/src/cli.ts'
import { parseCodexSession } from '../tools/session-archive/src/codex.ts'
import { renderMarkdown } from '../tools/session-archive/src/markdown.ts'
import { sanitizeText } from '../tools/session-archive/src/privacy.ts'

async function fixture(lines: unknown[], name = 'session.jsonl'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tpl-session-archive-'))
  const path = join(dir, name)
  await writeFile(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return path
}

test('Codex parser exports visible messages and tools but excludes hidden reasoning', async () => {
  const path = await fixture([
    { timestamp: '2026-08-12T01:00:00Z', type: 'session_meta', payload: { id: 'codex-fixture', cwd: '/tmp/project' } },
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
  assert.match(rendered.markdown, /TOOL · CALL/)
  assert.match(rendered.markdown, /TOOL · RESULT/)
  assert.match(rendered.markdown, /```text/)
  assert.match(rendered.markdown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(rendered.markdown, /private chain of thought/)
  assert.doesNotMatch(rendered.markdown, /duplicate legacy prompt/)
  assert.doesNotMatch(rendered.markdown, /<(?:details|h6|dl)\b/)
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
  const output = join(root, 'notes', 'archive.md')

  assert.equal(await run(['codex', sessionId, '--codex-home', root, '--output', output]), 0)
  const markdown = await readFile(output, 'utf8')
  assert.match(markdown, /Archive this/)
  assert.equal((await stat(output)).mode & 0o777, 0o600)
  assert.equal(await run(['codex', sessionId, '--codex-home', root, '--output', output]), 4)
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
})
