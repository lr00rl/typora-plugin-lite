import test from 'node:test'
import assert from 'node:assert/strict'

import { composeWikiLine, parseWikiLine } from '../plugins/note-assistant/src/wiki-line.ts'

test('parse accepts the exact shape the vault generator writes', () => {
  const parsed = parseWikiLine('- [[../a/go_zen|Go Zen]] - 同目录, 共词·并发')
  assert.deepEqual(parsed, {
    rawTarget: '../a/go_zen',
    displayTitle: 'Go Zen',
    reasonText: '同目录, 共词·并发',
  })
})

test('round-trip: parse(compose(x)) preserves target, title, and reason', () => {
  const item = { target: '../A200/raft', title: 'Raft 共识 算法', reasonText: '共词·分布式' }
  assert.deepEqual(parseWikiLine(composeWikiLine(item)), {
    rawTarget: item.target,
    displayTitle: item.title,
    reasonText: item.reasonText,
  })
})

test('round-trip without a reason', () => {
  const item = { target: 'a/b/c', title: 'C' }
  const parsed = parseWikiLine(composeWikiLine(item))
  assert.equal(parsed?.rawTarget, 'a/b/c')
  assert.equal(parsed?.displayTitle, 'C')
  assert.equal(parsed?.reasonText, '')
})

test('a reason containing a pipe survives the round-trip', () => {
  const item = { target: 'x', title: 'y', reasonText: 'a | b' }
  assert.equal(parseWikiLine(composeWikiLine(item))?.reasonText, 'a | b')
})

test('bare lines without a bullet parse too (DOM textContent has no bullet)', () => {
  assert.equal(parseWikiLine('[[a|b]]')?.displayTitle, 'b')
  assert.equal(parseWikiLine('* [[a]]')?.rawTarget, 'a')
})

test('a missing display title stays empty for the caller to derive', () => {
  const parsed = parseWikiLine('- [[../a/go_zen.md]]')
  assert.equal(parsed?.rawTarget, '../a/go_zen.md')
  assert.equal(parsed?.displayTitle, '')
})

test('non-link lines are rejected', () => {
  assert.equal(parseWikiLine('Tags: #a #b'), null)
  assert.equal(parseWikiLine('普通一句话'), null)
  assert.equal(parseWikiLine('- [markdown](link.md)'), null)
  assert.equal(parseWikiLine(''), null)
})
