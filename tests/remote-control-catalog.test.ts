import test from 'node:test'
import assert from 'node:assert/strict'

import {
  METHOD_SPECS,
  buildMethodCatalog,
} from '../plugins/remote-control/src/sidecar/catalog.ts'

function byName(state: Parameters<typeof buildMethodCatalog>[0]) {
  const map = new Map(buildMethodCatalog(state).map(m => [m.name, m]))
  return (name: string) => {
    const info = map.get(name)
    if (!info) throw new Error(`catalog missing ${name}`)
    return info
  }
}

test('open and auth methods are always available regardless of policy', () => {
  const get = byName({ allowExec: false, allowEval: false, typoraConnected: false })
  for (const name of ['session.authenticate', 'system.ping', 'system.getInfo', 'system.listMethods', 'system.shutdown']) {
    assert.equal(get(name).available, true, `${name} should be available`)
    assert.equal(get(name).unavailableReason, null)
  }
})

test('exec methods flip on allowExec', () => {
  const denied = byName({ allowExec: false, allowEval: false, typoraConnected: true })
  assert.equal(denied('exec.run').available, false)
  assert.match(denied('exec.run').unavailableReason ?? '', /allowExec=false/)

  const allowed = byName({ allowExec: true, allowEval: false, typoraConnected: true })
  assert.equal(allowed('exec.run').available, true)
  assert.equal(allowed('exec.start').available, true)
})

test('typora methods require a connected Typora session', () => {
  const offline = byName({ allowExec: true, allowEval: true, typoraConnected: false })
  assert.equal(offline('typora.getDocument').available, false)
  assert.match(offline('typora.getDocument').unavailableReason ?? '', /Typora session/)

  const online = byName({ allowExec: false, allowEval: false, typoraConnected: true })
  assert.equal(online('typora.getDocument').available, true)
  assert.equal(online('typora.getSelection').available, true)
})

test('eval needs BOTH allowEval and a Typora session, and reports the binding reason', () => {
  // allowEval off → 403 regardless of connectivity.
  assert.match(
    byName({ allowExec: false, allowEval: false, typoraConnected: true })('typora.eval').unavailableReason ?? '',
    /allowEval=false/,
  )
  // allowEval on but Typora gone → 503.
  assert.match(
    byName({ allowExec: false, allowEval: true, typoraConnected: false })('typora.eval').unavailableReason ?? '',
    /Typora session/,
  )
  // both satisfied → available.
  assert.equal(
    byName({ allowExec: false, allowEval: true, typoraConnected: true })('typora.eval').available,
    true,
  )
})

test('the catalog covers every method the server actually forwards or registers', () => {
  // Guards against the catalog drifting out of sync with server.ts. If a method
  // is added to the forward list but not here, listMethods would hide it.
  const names = new Set(METHOD_SPECS.map(m => m.name))
  const mustExist = [
    'session.authenticate',
    'system.ping', 'system.getInfo', 'system.listMethods', 'system.shutdown',
    'exec.run', 'exec.start', 'exec.kill', 'exec.list',
    'typora.getContext', 'typora.getDocument', 'typora.setDocument', 'typora.getSelection',
    'typora.setSourceMode', 'typora.insertText', 'typora.openFile', 'typora.openFolder',
    'typora.commands.list', 'typora.commands.invoke',
    'typora.plugins.list', 'typora.plugins.setEnabled',
    'typora.plugins.commands.list', 'typora.plugins.commands.invoke',
    'typora.eval',
  ]
  for (const name of mustExist) {
    assert.equal(names.has(name), true, `catalog is missing ${name}`)
  }
})

test('every spec carries a human summary', () => {
  for (const spec of METHOD_SPECS) {
    assert.ok(spec.summary.length > 0, `${spec.name} has no summary`)
  }
})
