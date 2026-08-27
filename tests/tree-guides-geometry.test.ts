import test from 'node:test'
import assert from 'node:assert/strict'

import { buildGuidePaths, type GuideGroup } from '../plugins/tree-guides/src/geometry.ts'

const METRICS = { arm: 14, radius: 8 }

function group(over: Partial<GuideGroup> = {}): GuideGroup {
  return { x: 10, top: 0, arms: [15, 45, 75], activeIndex: -1, ...over }
}

test('the trunk turns into the last row and every other row gets an arm', () => {
  const { base } = buildGuidePaths([group()], METRICS)
  // trunk, corner into the last arm, then one arm per earlier row
  assert.equal(base, 'M10,0L10,67Q10,75 18,75L24,75M10,15L24,15M10,45L24,45')
  assert.equal((base.match(/Q/g) ?? []).length, 1, 'exactly one corner per group')
  assert.equal((base.match(/M/g) ?? []).length, 3, 'one subpath per row')
})

test('an only child is the last child: a corner and nothing else', () => {
  const { base } = buildGuidePaths([group({ arms: [15] })], METRICS)
  assert.equal(base, 'M10,0L10,7Q10,15 18,15L24,15')
  assert.doesNotMatch(base, /M10,15L24,15/, 'no separate arm is drawn for it')
})

test('the corner never overshoots a group shorter than the radius', () => {
  const { base } = buildGuidePaths([group({ top: 10, arms: [14] })], METRICS)
  assert.equal(base, 'M10,10L10,10Q10,14 14,14L24,14', 'radius clamps to the drop')
})

test('the open file lights its own branch, trunk and arm, and nothing else', () => {
  const { lit } = buildGuidePaths([group({ activeIndex: 1 })], METRICS)
  assert.equal(lit, 'M10,0L10,45M10,45L24,45')
})

test('a lit last child reuses the corner rather than a straight drop', () => {
  const { lit } = buildGuidePaths([group({ activeIndex: 2 })], METRICS)
  assert.equal(lit, 'M10,0L10,67Q10,75 18,75L24,75')
})

test('groups off the active branch contribute nothing to the lit path', () => {
  const { lit } = buildGuidePaths([group(), group({ x: 30 })], METRICS)
  assert.equal(lit, '')
})

test('an empty group is skipped instead of emitting a stray stroke', () => {
  const { base, lit } = buildGuidePaths([group({ arms: [] })], METRICS)
  assert.equal(base, '')
  assert.equal(lit, '')
})

test('rows behind the pinned ancestors are dropped, the rest keep their shape', () => {
  // top: 120 is the bottom of a four-deep pinned breadcrumb; the first two
  // rows have scrolled up behind it.
  const { base } = buildGuidePaths([group({ top: 120, arms: [30, 60, 135, 165] })], METRICS)
  assert.equal(base, 'M10,120L10,157Q10,165 18,165L24,165M10,135L24,135')
  assert.doesNotMatch(base, /M10,30|M10,60/, 'nothing is drawn above the group top')
})

test('a group scrolled entirely behind the pinned stack draws nothing', () => {
  const { base, lit } = buildGuidePaths(
    [group({ top: 120, arms: [30, 60], activeIndex: 1 })],
    METRICS,
  )
  assert.equal(base, '')
  assert.equal(lit, '')
})

test('the lit branch stays off a row that has scrolled behind the pinned stack', () => {
  const { lit } = buildGuidePaths(
    [group({ top: 120, arms: [60, 165], activeIndex: 0 })],
    METRICS,
  )
  assert.equal(lit, '', 'no trunk running back up over the breadcrumb')
})
