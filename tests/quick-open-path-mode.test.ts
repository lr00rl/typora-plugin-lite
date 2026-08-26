import test from 'node:test'
import assert from 'node:assert/strict'

import {
  commonPrefix,
  completePath,
  filterEntries,
  isPathQuery,
  joinPath,
  parentInput,
  parsePathQuery,
  withLeaf,
} from '../plugins/fuzzy-search/src/path-mode.ts'

const ROOTS = { workspace: '/Users/me/vault', home: '/Users/me' }

const dir = (name: string) => ({ name, isDirectory: true })
const file = (name: string) => ({ name, isDirectory: false })

test('a leading slash is what switches modes, and nothing else does', () => {
  assert.equal(isPathQuery('/'), true)
  assert.equal(isPathQuery('//'), true)
  assert.equal(isPathQuery('~'), true)
  assert.equal(isPathQuery('~/Doc'), true)
  assert.equal(isPathQuery('notes/'), false, 'a slash later in the string is a search term')
  assert.equal(isPathQuery(''), false)
  assert.equal(isPathQuery('type:folder'), false)
})

test('one slash is the open folder, two is the filesystem', () => {
  assert.deepEqual(parsePathQuery('/', ROOTS), {
    kind: 'workspace', dir: '/Users/me/vault', leaf: '', typed: '/',
  })
  assert.deepEqual(parsePathQuery('//', ROOTS), {
    kind: 'filesystem', dir: '/', leaf: '', typed: '//',
  })
  // The two differ by a single character, so the order of the checks is the
  // entire distinction; guard it explicitly.
  assert.equal(parsePathQuery('//Users', ROOTS)!.kind, 'filesystem')
  assert.equal(parsePathQuery('/Users', ROOTS)!.kind, 'workspace')
})

test('the segment after the last slash filters its parent rather than joining it', () => {
  const q = parsePathQuery('/A000/A30', ROOTS)!
  assert.equal(q.dir, '/Users/me/vault/A000', 'lists the parent')
  assert.equal(q.leaf, 'A30', 'and filters by the partial segment')

  const done = parsePathQuery('/A000/A300/', ROOTS)!
  assert.equal(done.dir, '/Users/me/vault/A000/A300')
  assert.equal(done.leaf, '')
})

test('filesystem and home paths resolve against their own roots', () => {
  assert.equal(parsePathQuery('//usr/local/bi', ROOTS)!.dir, '/usr/local')
  assert.equal(parsePathQuery('//usr/local/bi', ROOTS)!.leaf, 'bi')
  assert.equal(parsePathQuery('~/Downloads/', ROOTS)!.dir, '/Users/me/Downloads')
  assert.equal(parsePathQuery('~', ROOTS)!.dir, '/Users/me')
})

test('with no folder open, a single slash falls back to the filesystem root', () => {
  const q = parsePathQuery('/etc/', { workspace: '', home: '/Users/me' })!
  assert.equal(q.kind, 'filesystem')
  assert.equal(q.dir, '/etc')
})

test('dot segments fold instead of being taken literally', () => {
  assert.equal(joinPath('/a/b', 'c/../d'), '/a/b/d')
  assert.equal(joinPath('/a/b', '../'), '/a')
  assert.equal(parsePathQuery('//usr/local/../', ROOTS)!.dir, '/usr')
})

test('directories sort first and dotfiles stay hidden until asked for', () => {
  const entries = [file('zeta.md'), dir('beta'), file('.hidden'), dir('.git'), file('alpha.md')]
  assert.deepEqual(filterEntries(entries, '').map(e => e.name), ['beta', 'alpha.md', 'zeta.md'])
  // Typing a dot is the deliberate act that reveals them.
  assert.deepEqual(filterEntries(entries, '.').map(e => e.name), ['.git', '.hidden'])
  assert.deepEqual(filterEntries(entries, 'A').map(e => e.name), ['alpha.md'], 'prefix match is case-insensitive')
})

test('completion advances by the shared prefix, never by a guess', () => {
  const entries = [dir('Documents'), dir('Downloads'), file('Desktop.md')]
  const { ghost, candidates } = completePath('~/D', entries)
  // Documents / Downloads / Desktop.md share only the "D" already typed, so
  // there is no safe advance and Tab must not invent one.
  assert.equal(ghost, '')
  assert.equal(candidates[0]!.insert, '~/Documents/', 'a directory candidate carries its trailing slash')
  assert.equal(candidates[0]!.label, 'Documents/')

  // Drop the odd one out and the shared prefix grows, so Tab can advance.
  assert.equal(completePath('~/D', [dir('Documents'), dir('Downloads')]).ghost, 'o')

  // One unambiguous match completes the whole way.
  const single = completePath('~/Dow', entries)
  assert.equal(single.ghost, 'nloads')
  assert.equal(single.candidates[0]!.insert, '~/Downloads/')

  // A file candidate does not get a slash, so Enter opens rather than drills.
  const fileOnly = completePath('~/Desk', entries)
  assert.equal(fileOnly.candidates[0]!.insert, '~/Desktop.md')
})

test('commonPrefix is the safe-advance primitive', () => {
  assert.equal(commonPrefix(['Documents', 'Downloads']), 'Do')
  assert.equal(commonPrefix(['abc']), 'abc')
  assert.equal(commonPrefix([]), '')
  assert.equal(commonPrefix(['abc', 'xyz']), '')
})

test('withLeaf replaces the partial segment, keeping everything before it', () => {
  assert.equal(withLeaf('/A000/A30', 'A300_AI'), '/A000/A300_AI')
  assert.equal(withLeaf('/', 'A000'), '/A000')
  assert.equal(withLeaf('//usr/lo', 'local'), '//usr/local')
})

test('climbing drops one segment and stops at the prefix', () => {
  assert.equal(parentInput('/a/b/'), '/a/')
  assert.equal(parentInput('/a/bc'), '/a/', 'a partial segment is cleared first')
  assert.equal(parentInput('/a/'), '/')
  assert.equal(parentInput('/'), '/', 'the mode is never left by climbing')
  assert.equal(parentInput('//usr/local/'), '//usr/')
  assert.equal(parentInput('//'), '//')
  assert.equal(parentInput('~/Documents/'), '~/')
  assert.equal(parentInput('~/'), '~/')
})

test('the trigger survives the tokens the 目录 tab writes into the box', async () => {
  // Drilling in the folders tab leaves `type:folder scope:X/` in the input, so
  // a slash typed there is not at position 0. Path mode keys off what the user
  // actually typed, which is what makes "或者在目录视图下也行" hold.
  const { removeToken } = await import('../plugins/fuzzy-search/src/query.ts')
  const typedText = (raw: string) => removeToken(removeToken(raw, 'type'), 'scope')

  assert.equal(typedText('type:folder scope:A000/ /etc'), '/etc')
  assert.equal(isPathQuery(typedText('type:folder scope:A000/ /etc')), true)
  assert.equal(isPathQuery(typedText('type:folder scope:A000/')), false, 'the tokens alone are not a path')
  assert.equal(isPathQuery(typedText('type:file 笔记')), false)

  const q = parsePathQuery(typedText('type:folder scope:A000/ //usr/'), ROOTS)!
  assert.equal(q.kind, 'filesystem')
  assert.equal(q.dir, '/usr')
})
