import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collapseDirectoryPathToFit,
  directoryPathForDisplay,
} from '../plugins/fuzzy-search/src/path-display.ts'

const byCharacters = (value: string): number => value.length

test('Quick Open path display removes the basename and keeps a directory boundary', () => {
  assert.equal(
    directoryPathForDisplay(
      'E000_Work/ProjectAtlas/数据平台/项目与资源/Research/TaskGroup_Archive/2026_08_12_revision.md',
    ),
    'E000_Work/ProjectAtlas/数据平台/项目与资源/Research/TaskGroup_Archive/',
  )
  assert.equal(
    directoryPathForDisplay('/Users/tester/workspace/notes/note.md'),
    '~/workspace/notes/',
  )
  assert.equal(directoryPathForDisplay('../../folder/note.md'), '../../folder/')
})

test('Quick Open collapses complete directory segments from the centre, then left and right', () => {
  const full = 'folder-1/folder-2/folder-3/folder-4/folder-5/folder-6/folder-7/'
  const first = 'folder-1/folder-2/folder-3/.../folder-5/folder-6/folder-7/'
  const second = 'folder-1/folder-2/.../folder-5/folder-6/folder-7/'
  const third = 'folder-1/folder-2/.../folder-6/folder-7/'

  assert.equal(collapseDirectoryPathToFit(full, full.length, byCharacters), full)
  assert.equal(collapseDirectoryPathToFit(full, first.length, byCharacters), first)
  assert.equal(collapseDirectoryPathToFit(full, second.length, byCharacters), second)
  assert.equal(collapseDirectoryPathToFit(full, third.length, byCharacters), third)
})

test('Quick Open preserves the first and last complete directories whenever they fit', () => {
  const full = 'E000_Work/ProjectAtlas/数据平台/项目与资源/Research/TaskGroup_Archive/'
  const minimum = 'E000_Work/.../TaskGroup_Archive/'

  assert.equal(
    collapseDirectoryPathToFit(full, minimum.length, byCharacters),
    minimum,
  )
})

test('Quick Open falls back to an ellipsis and the complete last directory under extreme pressure', () => {
  const full = 'E000_Work/ProjectAtlas/TaskGroup_Archive/'
  const fallback = '.../TaskGroup_Archive/'

  assert.equal(
    collapseDirectoryPathToFit(full, fallback.length, byCharacters),
    fallback,
  )
  assert.equal(
    collapseDirectoryPathToFit(full, 1, byCharacters),
    '...',
    'the path yields all remaining space to the filename when even the last directory cannot fit',
  )
})

test('Quick Open preserves drive, UNC, home, and relative-parent roots while collapsing', () => {
  const cases = [
    ['C:/first/middle/last/', 'C:/first/.../last/'],
    ['//server/share/first/middle/last/', '//server/share/first/.../last/'],
    ['~/first/middle/last/', '~/first/.../last/'],
    ['../../first/middle/last/', '../../first/.../last/'],
  ] as const

  for (const [full, collapsed] of cases) {
    assert.equal(
      collapseDirectoryPathToFit(full, collapsed.length, byCharacters),
      collapsed,
    )
  }

  assert.equal(
    collapseDirectoryPathToFit('//server/share/middle/last/', '//server/share/.../last/'.length, byCharacters),
    '//server/share/.../last/',
  )

  for (const full of [
    'C:/a/last/',
    '//very-long-server/very-long-share/a/last/',
    '../../a/last/',
  ]) {
    assert.equal(
      collapseDirectoryPathToFit(full, '.../last/'.length, byCharacters),
      '.../last/',
      'the last complete directory survives even when its root prefix does not fit',
    )
  }
})

test('Quick Open reduces a lone overlong path segment to an ellipsis', () => {
  assert.equal(collapseDirectoryPathToFit('one-very-long-directory/', 3, byCharacters), '...')
  assert.equal(collapseDirectoryPathToFit('/', 1, byCharacters), '/')
})

test('Quick Open fitting obeys measured width rather than string length', () => {
  const full = 'alpha/数据部门/omega/'
  const minimum = 'alpha/.../omega/'
  const measuredWidth = (value: string): number => (
    value === full ? 240 : value === minimum ? 120 : 80
  )

  assert.equal(collapseDirectoryPathToFit(full, 120, measuredWidth), minimum)
})
