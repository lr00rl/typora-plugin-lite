import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTENT_MIN_SCORE,
  contentSearchFailureCopy,
  contentSearchDebounceDelay,
  findContentHighlightRanges,
  parseAndRankContentMatches,
  parseRgFileCounts,
  selectContentCandidateFiles,
  tokenizeContentQuery,
} from '../plugins/fuzzy-search/src/content-search.ts'

test('content input debounce waits longer for broad queries and stays responsive for precise ones', () => {
  assert.equal(contentSearchDebounceDelay(''), 120)
  assert.equal(contentSearchDebounceDelay('q'), 420)
  assert.equal(contentSearchDebounceDelay('中文'), 320)
  assert.equal(contentSearchDebounceDelay('quick'), 240)
})

test('content-search failures never expose shell commands or absolute paths to the UI', () => {
  const timeout = contentSearchFailureCopy(
    new Error("Shell timeout: rg --json '/Users/private/vault/secret.md'"),
  )
  assert.equal(timeout.footer, '内容搜索超时')
  assert.match(timeout.message, /scope:/)
  assert.doesNotMatch(timeout.message, /\/Users\/private|secret\.md|rg --json/)

  const failure = contentSearchFailureCopy(new Error('permission denied: /Users/private/vault'))
  assert.equal(failure.footer, '内容搜索失败')
  assert.doesNotMatch(failure.message, /\/Users\/private|permission denied/)
})

function rgEvent(
  type: 'match' | 'context',
  path: string,
  line: number,
  text: string,
  matches: Array<{ text: string; start: number; end: number }> = [],
): string {
  return JSON.stringify({
    type,
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: line,
      absolute_offset: 0,
      submatches: matches.map(match => ({ match: { text: match.text }, start: match.start, end: match.end })),
    },
  })
}

test('content query tokenization is stable, case-insensitive, and de-duplicates terms', () => {
  assert.deepEqual(tokenizeContentQuery('  Alpha   beta alpha  中文  '), ['Alpha', 'beta', '中文'])
})

test('ripgrep count output keeps paths containing colons and selects the strongest file candidates', () => {
  const counts = parseRgFileCounts([
    '/vault/notes:archive/weak.md:2',
    '/vault/strong.md:19',
    'C:/vault/windows.md:7',
    '',
  ].join('\n'))

  assert.deepEqual(counts, [
    { path: '/vault/notes:archive/weak.md', count: 2 },
    { path: '/vault/strong.md', count: 19 },
    { path: 'C:/vault/windows.md', count: 7 },
  ])

  assert.deepEqual(selectContentCandidateFiles(counts, 2), {
    paths: ['/vault/strong.md', 'C:/vault/windows.md'],
    totalFiles: 3,
    truncated: true,
  })
})

test('content results rank complete close matches first and filter partial noise below the floor', () => {
  const stdout = [
    rgEvent('context', '/vault/notes/exact.md', 9, 'The decision record says:'),
    rgEvent('match', '/vault/notes/exact.md', 10, 'alpha beta ships together', [
      { text: 'alpha', start: 0, end: 5 },
      { text: 'beta', start: 6, end: 10 },
    ]),
    rgEvent('context', '/vault/notes/exact.md', 11, 'This is the original follow-up context.'),
    rgEvent('match', '/vault/notes/spread.md', 24, 'alpha belongs to this paragraph', [
      { text: 'alpha', start: 0, end: 5 },
    ]),
    rgEvent('context', '/vault/notes/spread.md', 25, 'beta is explained on the next line.'),
    rgEvent('match', '/vault/noise.md', 3, 'alpha alpha alpha alpha', [
      { text: 'alpha', start: 0, end: 5 },
      { text: 'alpha', start: 6, end: 11 },
      { text: 'alpha', start: 12, end: 17 },
      { text: 'alpha', start: 18, end: 23 },
    ]),
  ].join('\n')

  const matches = parseAndRankContentMatches(stdout, 'alpha beta', {
    root: '/vault',
    limit: 20,
    minScore: CONTENT_MIN_SCORE,
    fileHitCounts: new Map([
      ['/vault/notes/exact.md', 2],
      ['/vault/notes/spread.md', 2],
      ['/vault/noise.md', 40],
    ]),
  })

  assert.deepEqual(matches.map(match => match.basename), ['exact.md', 'spread.md'])
  assert.ok(matches[0]!.score > matches[1]!.score)
  assert.equal(matches[0]!.line, 10)
  assert.deepEqual(matches[0]!.contextLines, [
    { line: 9, text: 'The decision record says:', kind: 'before' },
    { line: 10, text: 'alpha beta ships together', kind: 'match' },
    { line: 11, text: 'This is the original follow-up context.', kind: 'after' },
  ])
  assert.ok(matches.every(match => match.score >= CONTENT_MIN_SCORE))
})

test('single-term content queries remain useful while exact highlights merge overlaps', () => {
  const stdout = rgEvent('match', '/vault/readme.md', 7, 'Alpha alphabet alpha', [
    { text: 'Alpha', start: 0, end: 5 },
    { text: 'alpha', start: 6, end: 11 },
    { text: 'alpha', start: 15, end: 20 },
  ])
  const matches = parseAndRankContentMatches(stdout, 'alpha', {
    root: '/vault',
    limit: 10,
    minScore: CONTENT_MIN_SCORE,
  })
  assert.equal(matches.length, 1)
  assert.deepEqual(findContentHighlightRanges('Alpha alphabet alpha', ['alpha', 'alphabet']), [
    { start: 0, end: 5 },
    { start: 6, end: 14 },
    { start: 15, end: 20 },
  ])
})
