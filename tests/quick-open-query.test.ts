import test from 'node:test'
import assert from 'node:assert/strict'

import {
  completeQuery,
  effectiveType,
  parseQuery,
  removeToken,
  resolveType,
  setToken,
} from '../plugins/fuzzy-search/src/query.ts'

// --- parseQuery --------------------------------------------------------------

test('a plain query is all terms, no operators', () => {
  const q = parseQuery('docker compose')
  assert.equal(q.type, null)
  assert.equal(q.scope, null)
  assert.equal(q.terms, 'docker compose')
})

test('type: resolves through aliases', () => {
  assert.equal(parseQuery('type:file x').type, 'file')
  assert.equal(parseQuery('type:f x').type, 'file')
  assert.equal(parseQuery('type:d x').type, 'folder')
  assert.equal(parseQuery('type:folder x').type, 'folder')
  assert.equal(parseQuery('type:c x').type, 'content')
  assert.equal(parseQuery('type:content x').type, 'content')
})

test('an unknown type value is ignored (stays null)', () => {
  assert.equal(parseQuery('type:banana x').type, null)
})

test('scope: is path-normalized and quotes are stripped', () => {
  assert.equal(parseQuery('scope:"D000_RTFS/" foo').scope, 'D000_RTFS')
  assert.equal(parseQuery('scope:a/b/ foo').scope, 'a/b')
  assert.equal(parseQuery('scope:/a/b foo').scope, 'a/b')
})

test('operators are stripped from terms wherever they appear', () => {
  const q = parseQuery('docker type:content scope:ops/ compose')
  assert.equal(q.type, 'content')
  assert.equal(q.scope, 'ops')
  assert.equal(q.terms, 'docker compose')
})

test('a scope with spaces must be quoted to survive', () => {
  const q = parseQuery('scope:"my notes/sub" find me')
  assert.equal(q.scope, 'my notes/sub')
  assert.equal(q.terms, 'find me')
})

test('effectiveType falls back to the tab default only when unset', () => {
  assert.equal(effectiveType(parseQuery('foo'), 'folder'), 'folder')
  assert.equal(effectiveType(parseQuery('type:content foo'), 'folder'), 'content')
})

test('resolveType exposes the alias table', () => {
  assert.equal(resolveType('F'), 'file')
  assert.equal(resolveType('nope'), null)
})

// --- setToken / removeToken --------------------------------------------------

test('setToken inserts a new operator without disturbing terms', () => {
  assert.equal(setToken('docker compose', 'scope', 'ops'), 'scope:ops docker compose')
})

test('setToken replaces an existing operator in place', () => {
  assert.equal(setToken('scope:old docker', 'scope', 'new'), 'scope:new docker')
  assert.equal(setToken('type:file scope:old x', 'scope', 'new'), 'type:file scope:new x')
})

test('setToken quotes values containing spaces', () => {
  assert.equal(parseQuery(setToken('x', 'scope', 'a b/c')).scope, 'a b/c')
})

test('setToken preserves the user type when only scope changes', () => {
  // The drill-into-folder behaviour: update scope, leave type: alone.
  const out = setToken('type:folder scope:a foo', 'scope', 'a/b')
  const q = parseQuery(out)
  assert.equal(q.type, 'folder', 'user type preserved')
  assert.equal(q.scope, 'a/b', 'scope updated')
  assert.equal(q.terms, 'foo', 'terms preserved')
})

test('setToken with an empty value removes the operator', () => {
  assert.equal(parseQuery(setToken('scope:a foo', 'scope', '')).scope, null)
})

test('removeToken drops just that operator', () => {
  const out = removeToken('type:content scope:a foo', 'scope')
  const q = parseQuery(out)
  assert.equal(q.scope, null)
  assert.equal(q.type, 'content')
  assert.equal(q.terms, 'foo')
})

// --- completeQuery -----------------------------------------------------------

const DIRS = [
  { path: 'D000_RTFS', fileCount: 12 },
  { path: 'D001_Notes', fileCount: 3 },
  { path: 'D000_RTFS/sub', fileCount: 4 },
  { path: 'D000_RTFS/scratch', fileCount: 1 },
  { path: 'Ops', fileCount: 40 },
]

test('a bare operator prefix completes to the operator keyword', () => {
  const r = completeQuery('sc', 2, DIRS)
  assert.equal(r.candidates[0]?.label, 'scope:')
  assert.equal(r.ghost, 'ope:')
  const r2 = completeQuery('ty', 2, DIRS)
  assert.equal(r2.candidates[0]?.label, 'type:')
})

test('type: value completes by prefix and alias', () => {
  const r = completeQuery('type:f', 6, DIRS)
  const labels = r.candidates.map(c => c.label)
  assert.ok(labels.includes('type:file'))
  assert.ok(labels.includes('type:folder'), 'both file and folder start with f')
  const rd = completeQuery('type:d', 6, DIRS)
  assert.deepEqual(rd.candidates.map(c => c.label), ['type:folder'], 'alias d → folder')
})

test('scope: completes top-level directories by prefix', () => {
  const r = completeQuery('scope:D0', 8, DIRS)
  assert.deepEqual(r.candidates.map(c => c.label), ['scope:D000_RTFS/', 'scope:D001_Notes/'])
  assert.equal(r.candidates[0]?.hint, '12 个文件')
})

test('scope: completes one path segment at a time, not every descendant', () => {
  // "scope:D0" must NOT dump D000_RTFS/sub etc. — only the top level.
  const top = completeQuery('scope:D0', 8, DIRS)
  assert.ok(!top.candidates.some(c => c.label.includes('/sub')), 'descendants excluded at top level')

  // Once a parent is committed, its immediate children complete.
  const child = completeQuery('scope:D000_RTFS/s', 17, DIRS)
  assert.deepEqual(
    child.candidates.map(c => c.label).sort(),
    ['scope:D000_RTFS/scratch/', 'scope:D000_RTFS/sub/'],
  )
})

test('accepting a completion produces the full new input and cursor', () => {
  const r = completeQuery('docker type:f', 13, DIRS)
  const top = r.candidates.find(c => c.label === 'type:file')!
  assert.equal(top.insert, 'docker type:file')
  assert.equal(top.cursor, 'docker type:file'.length)
})

test('completion targets the token under the cursor, not the end of the string', () => {
  // cursor sits right after "type:f", before " foo"
  const raw = 'type:f foo'
  const r = completeQuery(raw, 6, DIRS)
  const top = r.candidates.find(c => c.label === 'type:file')!
  assert.equal(top.insert, 'type:file foo')
})

test('no completion for a plain finished word', () => {
  assert.deepEqual(completeQuery('docker ', 7, DIRS).candidates, [])
  assert.deepEqual(completeQuery('hello', 5, DIRS).candidates, [])
})
