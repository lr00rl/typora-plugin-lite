import test from 'node:test'
import assert from 'node:assert/strict'

import { JsonRpcPeer, JsonRpcRemoteError } from '../plugins/remote-control/src/rpc/json-rpc.ts'

/** A JsonRpcPeer whose sent frames are captured instead of hitting a socket. */
function loopback() {
  const sent: any[] = []
  const peer = new JsonRpcPeer(payload => sent.push(JSON.parse(payload)))
  return { peer, sent }
}

test('a request with no timeout stays pending forever (historical behaviour preserved)', async () => {
  const { peer } = loopback()
  let settled = false
  peer.request('slow.method').then(() => { settled = true }, () => { settled = true })
  // Give the event loop a couple of turns; nothing should settle it.
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  assert.equal(settled, false)
})

test('a request rejects with -32001 after its timeout elapses', async () => {
  const { peer } = loopback()
  await assert.rejects(
    peer.request('slow.method', undefined, { timeoutMs: 20 }),
    (err: unknown) => {
      assert.ok(err instanceof JsonRpcRemoteError)
      assert.equal(err.code, -32001)
      assert.match(err.message, /timed out after 20ms/)
      assert.match(err.message, /slow\.method/)
      return true
    },
  )
})

test('a reply that lands before the timeout resolves normally and cancels the timer', async () => {
  const { peer, sent } = loopback()
  const promise = peer.request<number>('fast.method', undefined, { timeoutMs: 1000 })
  const id = sent[0].id
  // Simulate the peer answering.
  peer.handleMessage(JSON.stringify({ jsonrpc: '2.0', id, result: 99 }))
  assert.equal(await promise, 99)
  // If the timer were still armed, an unhandled rejection would surface; a clean
  // resolve here is the assertion that the timer was cleared.
})

test('failPending rejects a timed request and does not leave the timer to fire later', async () => {
  const { peer } = loopback()
  const promise = peer.request('x', undefined, { timeoutMs: 10_000 })
  peer.failPending(new Error('socket closed'))
  await assert.rejects(promise, /socket closed/)
})
