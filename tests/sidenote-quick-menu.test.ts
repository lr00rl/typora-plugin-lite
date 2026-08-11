import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

import { bindQuickAction, isQuickMenuOpen } from '../plugins/sidenote/src/quick-menu.ts'

test('recognizes the flex quick menu as open', () => {
  const window = new Window()
  const menu = window.document.createElement('div')
  menu.style.display = 'flex'
  menu.classList.add('tpl-sn-menu-visible')

  assert.equal(isQuickMenuOpen(menu as unknown as HTMLDivElement), true)
  window.close()
})

test('mouse activation runs once and keyboard-style click also runs once', () => {
  const window = new Window()
  const button = window.document.createElement('button')
  let calls = 0
  bindQuickAction(button as unknown as HTMLButtonElement, () => { calls += 1 })

  button.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.equal(calls, 1)

  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.equal(calls, 2)
  window.close()
})
