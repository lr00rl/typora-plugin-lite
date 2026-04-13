import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldMutateLiveSidenoteDom } from '../plugins/sidenote/src/dom-guards.ts'

function makeNode(isFocused: boolean) {
  return {
    closest(selector: string) {
      if (selector !== '.md-focus') return null
      return isFocused ? {} : null
    },
  }
}

test('allows sidenote DOM mutation when not composing and target is outside the focused block', () => {
  assert.equal(shouldMutateLiveSidenoteDom(makeNode(false), false), true)
})

test('blocks sidenote DOM mutation while IME composition is active', () => {
  assert.equal(shouldMutateLiveSidenoteDom(makeNode(false), true), false)
})

test('blocks sidenote DOM mutation inside the active editing block', () => {
  assert.equal(shouldMutateLiveSidenoteDom(makeNode(true), false), false)
})
