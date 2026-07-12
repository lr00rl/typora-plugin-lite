import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fuzzyMatchPositions,
  fzfScore,
  scoreCandidate,
  type ScoreKeys,
} from '../plugins/fuzzy-search/src/scoring.ts'

test('a subsequence match scores finitely; a non-match is -Infinity', () => {
  assert.ok(Number.isFinite(fzfScore('readme.md', 'rme')))
  assert.equal(fzfScore('readme.md', 'xyz'), -Infinity)
})

test('consecutive and prefix matches outscore scattered ones', () => {
  assert.ok(fzfScore('readme', 'read') > fzfScore('readme', 'rme'))
  assert.ok(fzfScore('readme', 'read') > fzfScore('unrelated-readme', 'read'))
})

test('word-boundary matches beat mid-word matches', () => {
  // "qo" hitting the start of two segments beats hitting mid-word letters.
  assert.ok(fzfScore('quick-open', 'qo') > fzfScore('aquietkorner', 'qo'))
})

test('fuzzyMatchPositions returns the consumed indices or null', () => {
  assert.deepEqual(fuzzyMatchPositions('abc', 'ac'), [0, 2])
  assert.equal(fuzzyMatchPositions('abc', 'z'), null)
  assert.deepEqual(fuzzyMatchPositions('abc', ''), [])
})

function keys(basename: string, rel: string, cwd = rel): ScoreKeys {
  return { basenameKey: basename.toLowerCase(), relPathKey: rel.toLowerCase(), cwdRelPathKey: cwd.toLowerCase() }
}

test('scoreCandidate favours a basename hit over a deep-path-only hit', () => {
  const nameHit = scoreCandidate(keys('notes.md', 'a/b/notes.md'), 'notes', { isPathQuery: false })
  const pathHit = scoreCandidate(keys('index.md', 'notes/deep/index.md'), 'notes', { isPathQuery: false })
  assert.ok(nameHit > pathHit)
})

test('a path-like query leans on the cwd-relative key', () => {
  const score = scoreCandidate(keys('c.md', 'x/y/c.md', '../y/c.md'), '../y/c', { isPathQuery: true })
  assert.ok(Number.isFinite(score))
})

test('frecency boost lifts an otherwise-equal candidate', () => {
  const k = keys('notes.md', 'notes.md')
  const cold = scoreCandidate(k, 'notes', { isPathQuery: false })
  const hot = scoreCandidate(k, 'notes', { isPathQuery: false, frecencyBoost: 30 })
  assert.equal(hot, cold + 30)
})

test('frecency boost never rescues a non-match', () => {
  const score = scoreCandidate(keys('readme.md', 'readme.md'), 'zzz', { isPathQuery: false, frecencyBoost: 1000 })
  assert.equal(score, -Infinity)
})
