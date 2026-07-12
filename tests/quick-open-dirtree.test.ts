import test from 'node:test'
import assert from 'node:assert/strict'

import {
  allDirectories,
  breadcrumbs,
  listChildren,
  normalizePrefix,
  parentPrefix,
} from '../plugins/fuzzy-search/src/dirtree.ts'

const VAULT = [
  'README.md',
  'notes/daily/2026-01.md',
  'notes/daily/2026-02.md',
  'notes/ideas.md',
  'projects/alpha/spec.md',
  'projects/alpha/tasks.md',
  'projects/beta.md',
]

test('root lists top-level folders (collapsed) and files, folders first', () => {
  const children = listChildren(VAULT, '')
  assert.deepEqual(
    children.map(c => `${c.kind}:${c.name}`),
    ['dir:notes', 'dir:projects', 'file:README.md'],
  )
})

test('a directory reports how many files live anywhere beneath it', () => {
  const notes = listChildren(VAULT, '').find(c => c.name === 'notes')!
  assert.equal(notes.fileCount, 3) // daily/2026-01, daily/2026-02, ideas
  const projects = listChildren(VAULT, '').find(c => c.name === 'projects')!
  assert.equal(projects.fileCount, 3) // alpha/spec, alpha/tasks, beta
})

test('descending shows only that folder\'s immediate children', () => {
  const children = listChildren(VAULT, 'notes')
  assert.deepEqual(
    children.map(c => `${c.kind}:${c.name}`),
    ['dir:daily', 'file:ideas.md'],
  )
  assert.equal(children.find(c => c.name === 'daily')!.path, 'notes/daily')
})

test('a leaf directory lists its files with full workspace paths', () => {
  const children = listChildren(VAULT, 'notes/daily')
  assert.deepEqual(children.map(c => c.path), ['notes/daily/2026-01.md', 'notes/daily/2026-02.md'])
  assert.ok(children.every(c => c.kind === 'file'))
})

test('trailing/leading slashes and backslashes in the prefix are tolerated', () => {
  const a = listChildren(VAULT, '/notes/')
  const b = listChildren(VAULT, 'notes\\')
  const c = listChildren(VAULT, 'notes')
  assert.deepEqual(a, c)
  assert.deepEqual(b, c)
})

test('an unknown prefix yields nothing rather than throwing', () => {
  assert.deepEqual(listChildren(VAULT, 'does/not/exist'), [])
})

test('normalizePrefix strips separators to a bare a/b form', () => {
  assert.equal(normalizePrefix('/a/b/'), 'a/b')
  assert.equal(normalizePrefix('a\\b'), 'a/b')
  assert.equal(normalizePrefix(''), '')
})

test('parentPrefix walks up one level and stops at root', () => {
  assert.equal(parentPrefix('a/b/c'), 'a/b')
  assert.equal(parentPrefix('a'), '')
  assert.equal(parentPrefix(''), '')
})

test('breadcrumbs expand a prefix into cumulative segments', () => {
  assert.deepEqual(breadcrumbs('projects/alpha'), [
    { name: 'projects', path: 'projects' },
    { name: 'alpha', path: 'projects/alpha' },
  ])
  assert.deepEqual(breadcrumbs(''), [])
})

test('allDirectories enumerates every directory with a nested-file count', () => {
  const dirs = allDirectories(VAULT)
  const byPath = Object.fromEntries(dirs.map(d => [d.path, d.fileCount]))
  assert.equal(byPath['notes'], 3)
  assert.equal(byPath['notes/daily'], 2)
  assert.equal(byPath['projects'], 3)
  assert.equal(byPath['projects/alpha'], 2)
  assert.equal(byPath['README.md'], undefined, 'files are not directories')
})

test('allDirectories can be scoped to a subtree, excluding the scope itself', () => {
  const dirs = allDirectories(VAULT, 'projects')
  assert.deepEqual(dirs.map(d => d.path), ['projects/alpha'])
})
