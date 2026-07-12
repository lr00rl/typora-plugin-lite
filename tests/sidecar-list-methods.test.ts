import test from 'node:test'
import assert from 'node:assert/strict'

import { createSidecarServer } from '../plugins/remote-control/src/sidecar/server.ts'

interface RpcEnvelope {
  id?: number
  result?: any
  error?: { code: number; message: string }
}

function newClient(url: string) {
  const ws = new WebSocket(url)
  const pending = new Map<number, (env: RpcEnvelope) => void>()
  let nextId = 1
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data)) as RpcEnvelope
    if (msg.id != null) pending.get(msg.id)?.(msg)
  })
  const open = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
  })
  const call = (method: string, params?: unknown): Promise<RpcEnvelope> => {
    const id = nextId++
    const promise = new Promise<RpcEnvelope>((resolve) => { pending.set(id, resolve) })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return promise
  }
  return { ws, open, call }
}

test('system.listMethods requires authentication', async () => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret' })
  try {
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open
    const res = await client.call('system.listMethods')
    assert.equal(res.error?.code, 401)
    client.ws.close()
  } finally {
    await server.close()
  }
})

test('system.listMethods reflects the live policy: exec/eval gated, typora offline', async () => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret' })
  try {
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open
    await client.call('session.authenticate', { token: 'secret', role: 'client' })

    const res = await client.call('system.listMethods')
    assert.equal(res.error, undefined)
    const methods: Array<{ name: string; available: boolean; unavailableReason: string | null }> = res.result.methods
    const find = (name: string) => methods.find(m => m.name === name)!

    // No Typora session connected in this test, exec/eval default-off.
    assert.equal(find('system.ping').available, true)
    assert.equal(find('exec.run').available, false)
    assert.equal(find('typora.getDocument').available, false)
    assert.equal(find('typora.eval').available, false)
    assert.match(find('exec.run').unavailableReason!, /allowExec=false/)
  } finally {
    await server.close()
  }
})

test('system.listMethods shows exec available once allowExec=true', async () => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret', allowExec: true })
  try {
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open
    await client.call('session.authenticate', { token: 'secret', role: 'client' })

    const res = await client.call('system.listMethods')
    const methods: Array<{ name: string; available: boolean }> = res.result.methods
    assert.equal(methods.find(m => m.name === 'exec.run')!.available, true)
    client.ws.close()
  } finally {
    await server.close()
  }
})
