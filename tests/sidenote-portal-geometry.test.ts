import test from 'node:test'
import assert from 'node:assert/strict'

import { getPortalPagePosition } from '../plugins/sidenote/src/portal-geometry.ts'

test('computes page-relative portal coordinates for a body-mounted layer', () => {
  const position = getPortalPagePosition(
    { top: 240, right: 980 },
    { right: 980 },
    { reserve: 300, offset: 280, width: 250 },
    { scrollX: 32, scrollY: 120 },
  )

  assert.deepEqual(position, {
    top: 360,
    left: 742,
  })
})

test('keeps left edge stable when scrollY changes but horizontal geometry does not', () => {
  const before = getPortalPagePosition(
    { top: 100, right: 900 },
    { right: 900 },
    { reserve: 320, offset: 280, width: 240 },
    { scrollX: 0, scrollY: 0 },
  )
  const after = getPortalPagePosition(
    { top: 60, right: 900 },
    { right: 900 },
    { reserve: 320, offset: 280, width: 240 },
    { scrollX: 0, scrollY: 40 },
  )

  assert.equal(before.left, after.left)
  assert.equal(before.top, after.top)
})
