import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveScopeRows,
  filterRows,
  reasonBadge,
  type RowContext,
} from '../plugins/note-assistant/src/rows.ts'
import type { GraphNote } from '../plugins/note-assistant/src/types.ts'

const CURRENT = '/vault/A000/dir/当前笔记.md'
const ROOT = '/vault'

function makeNote(partial: Partial<GraphNote>): GraphNote {
  return { relPath: 'A000/dir/当前笔记.md', title: '当前笔记', ...partial }
}

function contextWith(entries: GraphNote[]): RowContext {
  return {
    noteMap: new Map(entries.map(note => [note.relPath, note])),
    currentFile: CURRENT,
    rootDir: ROOT,
  }
}

test('reasonBadge prefers explicit links over proximity over shared terms', () => {
  assert.equal(reasonBadge({ explicitLink: true, sameDirectory: true }), '链接')
  assert.equal(reasonBadge({ backlink: true, sameTopLevel: true }), '反链')
  assert.equal(reasonBadge({ sameDirectory: true }), '同目录')
  assert.equal(reasonBadge({ sameTopLevel: true }), '同分区')
  assert.equal(reasonBadge({ sharedTerms: ['分布式', '数据'] }), '共词·分布式')
  assert.equal(reasonBadge({}), '')
  assert.equal(reasonBadge(undefined), '')
})

test('related scope keeps graph order and precomputes wiki targets', () => {
  const note = makeNote({
    related: [
      { relPath: 'A000/dir/同目录.md', title: '同目录', score: 9, reasons: { sameDirectory: true } },
      { relPath: 'A000/other/远些.md', title: '远些', score: 1, reasons: {} },
    ],
  })
  const rows = deriveScopeRows(note, 'related', contextWith([]))
  assert.deepEqual(rows.map(row => row.relPath), ['A000/dir/同目录.md', 'A000/other/远些.md'])
  assert.equal(rows[0].target, '同目录')
  assert.equal(rows[1].target, '../other/远些')
  assert.equal(rows[0].badge, '同目录')
})

test('links scope lists outbound then inbound, deduped by first occurrence', () => {
  const note = makeNote({
    explicitLinks: ['A000/x.md', 'A000/y.md'],
    backlinks: ['A000/y.md', 'A000/z.md'],
  })
  const context = contextWith([
    { relPath: 'A000/y.md', title: '图谱里的标题' },
  ] as GraphNote[])
  const rows = deriveScopeRows(note, 'links', context)
  assert.deepEqual(rows.map(row => row.relPath), ['A000/x.md', 'A000/y.md', 'A000/z.md'])
  assert.deepEqual(rows.map(row => row.badge), ['出链', '出链', '入链'])
  assert.equal(rows[1].title, '图谱里的标题')
  assert.equal(rows[2].title, 'z')
})

test('candidates scope preserves graph score order', () => {
  const note = makeNote({
    candidates: [
      { relPath: 'A000/a.md', title: 'A', score: 100, reasons: {} },
      { relPath: 'A000/b.md', title: 'B', score: 50, reasons: {} },
      { relPath: 'A000/c.md', title: 'C', score: 1, reasons: {} },
    ],
  })
  const rows = deriveScopeRows(note, 'candidates', contextWith([]))
  assert.deepEqual(rows.map(row => row.title), ['A', 'B', 'C'])
})

test('candidates scope hides entries already curated into related', () => {
  const note = makeNote({
    related: [{ relPath: 'A000/a.md', title: 'A', score: 100, reasons: {} }],
    candidates: [
      { relPath: 'A000/a.md', title: 'A', score: 100, reasons: {} },
      { relPath: 'A000/b.md', title: 'B', score: 50, reasons: {} },
    ],
  })
  const rows = deriveScopeRows(note, 'candidates', contextWith([]))
  assert.deepEqual(rows.map(row => row.title), ['B'])
})

test('a missing note yields no rows in any scope', () => {
  const context = contextWith([])
  assert.deepEqual(deriveScopeRows(null, 'related', context), [])
  assert.deepEqual(deriveScopeRows(null, 'links', context), [])
  assert.deepEqual(deriveScopeRows(null, 'candidates', context), [])
})

test('filterRows with an empty query keeps everything without highlights', () => {
  const note = makeNote({
    related: [{ relPath: 'A000/a.md', title: '分布式系统', score: 1, reasons: {} }],
  })
  const rows = deriveScopeRows(note, 'related', contextWith([]))
  const filtered = filterRows(rows, '   ')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].titlePositions, null)
})

test('filterRows matches CJK titles as subsequences and preserves order', () => {
  const note = makeNote({
    related: [
      { relPath: 'A000/a.md', title: '分布式事务', score: 2, reasons: {} },
      { relPath: 'A000/b.md', title: '算法导论', score: 1, reasons: {} },
      { relPath: 'A000/c.md', title: '分布的 系统设计', score: 3, reasons: {} },
    ],
  })
  const rows = deriveScopeRows(note, 'related', contextWith([]))
  const filtered = filterRows(rows, '分布')
  assert.deepEqual(filtered.map(item => item.row.title), ['分布式事务', '分布的 系统设计'])
  assert.deepEqual(filtered[0].titlePositions, [0, 1])
})

test('filterRows matches on path and on tags', () => {
  const note = makeNote({
    related: [
      { relPath: 'A400_Softer/Linux/tmux.md', title: '终端复用', score: 1, reasons: {} },
      { relPath: 'A000/a.md', title: '无关', score: 1, reasons: {} },
    ],
  })
  const context = contextWith([
    { relPath: 'A000/a.md', title: '无关', tags: ['raft'] },
  ] as GraphNote[])
  const rows = deriveScopeRows(note, 'related', context)
  assert.deepEqual(filterRows(rows, 'tmux').map(item => item.row.title), ['终端复用'])
  assert.deepEqual(filterRows(rows, 'raft').map(item => item.row.title), ['无关'])
  assert.deepEqual(filterRows(rows, 'zzz'), [])
})
