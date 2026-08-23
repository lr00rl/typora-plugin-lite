import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveTitleFromTarget,
  normalizePath,
  relPathFromDir,
  relPathFromRoot,
  targetCandidates,
  wikiTargetFor,
  withoutMarkdownExt,
} from '../plugins/note-assistant/src/links.ts'

test('relPathFromDir handles same-dir, parent, and sibling targets', () => {
  assert.equal(relPathFromDir('/v/a/b/x.md', '/v/a/b'), 'x.md')
  assert.equal(relPathFromDir('/v/a/x.md', '/v/a/b'), '../x.md')
  assert.equal(relPathFromDir('/v/a/c/x.md', '/v/a/b'), '../c/x.md')
  assert.equal(relPathFromDir('/v/a/b', '/v/a/b'), '.')
})

test('relPathFromDir returns the target untouched on a root-prefix mismatch', () => {
  assert.equal(relPathFromDir('D:/vault/x.md', 'C:/vault/a'), 'D:/vault/x.md')
  assert.equal(relPathFromDir('/vault/x.md', ''), '/vault/x.md')
})

test('Windows separators and drive letters normalize before math', () => {
  assert.equal(normalizePath('C:\\vault\\a'), 'C:/vault/a')
  const target = wikiTargetFor('b/x.md', 'C:\\vault\\a\\note.md', 'C:\\vault')
  assert.equal(target, '../b/x')
})

test('wikiTargetFor strips the extension and keeps CJK and spaces raw', () => {
  const target = wikiTargetFor(
    'A000_Theoretical_Knowledge/A200_Algorithm/A2001_DistributedSystem/raft.md',
    '/Users/me/vault/A000_Theoretical_Knowledge/A400_Softer/读书笔记.md',
    '/Users/me/vault',
  )
  assert.equal(target, '../A200_Algorithm/A2001_DistributedSystem/raft')
})

test('wikiTargetFor for a same-directory note is the bare name', () => {
  assert.equal(wikiTargetFor('a/b/同目录 笔记.markdown', '/v/a/b/current.md', '/v'), '同目录 笔记')
})

test('withoutMarkdownExt strips .md and .markdown, case-insensitively', () => {
  assert.equal(withoutMarkdownExt('x.md'), 'x')
  assert.equal(withoutMarkdownExt('x.Markdown'), 'x')
  assert.equal(withoutMarkdownExt('x.txt'), 'x.txt')
})

test('relPathFromRoot only strips an actual prefix match', () => {
  assert.equal(relPathFromRoot('/v/a/b.md', '/v'), 'a/b.md')
  assert.equal(relPathFromRoot('/other/b.md', '/v'), '/other/b.md')
})

test('deriveTitleFromTarget uses the basename and softens separators', () => {
  assert.equal(deriveTitleFromTarget('../a/go_zen.md'), 'go zen')
  assert.equal(deriveTitleFromTarget('dir/note.md#章节'), 'note')
})

test('targetCandidates tries current-dir first, then root-relative, with extensions', () => {
  const { candidates } = targetCandidates('../other/x', '/v/a/note.md', '/v')
  assert.deepEqual(candidates, [
    '/v/other/x',
    '/v/other/x.md',
    '/v/other/x.markdown',
    '/other/x',
    '/other/x.md',
    '/other/x.markdown',
  ])
})

test('targetCandidates strips heading suffixes and respects a given extension', () => {
  const { candidates } = targetCandidates('b/x.md#一节', '/v/a/note.md', '/v')
  assert.deepEqual(candidates, ['/v/a/b/x.md', '/v/b/x.md'])
})

test('targetCandidates rejects an empty target', () => {
  assert.deepEqual(targetCandidates('#只有标题', '/v/a/note.md', '/v').candidates, [])
})
