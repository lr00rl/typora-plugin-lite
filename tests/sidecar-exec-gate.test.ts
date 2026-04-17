import test from 'node:test'
import assert from 'node:assert/strict'

import { createSidecarServer } from '../plugins/remote-control/src/sidecar/server.ts'

interface RpcEnvelope {
  id?: number
  result?: unknown
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

async function authenticate(call: (m: string, p?: unknown) => Promise<RpcEnvelope>, token: string) {
  const res = await call('session.authenticate', { token, role: 'client' })
  assert.equal(res.error, undefined, `authenticate should succeed: ${JSON.stringify(res.error)}`)
}

test('exec.run is rejected with 403 when allowExec=false (default)', async () => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret' })
  try {
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open
    await authenticate(client.call, 'secret')

    const res = await client.call('exec.run', { command: 'echo hi' })
    assert.ok(res.error, 'must error')
    assert.equal(res.error!.code, 403)
    assert.match(res.error!.message, /exec disabled/i)

    client.ws.close()
  } finally {
    await server.close()
  }
})

test('exec.start, exec.kill, exec.list all reject 403 when allowExec=false', async () => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret' })
  try {
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open
    await authenticate(client.call, 'secret')

    for (const method of ['exec.start', 'exec.kill', 'exec.list']) {
      const res = await client.call(method, {})
      assert.ok(res.error, `${method} must error`)
      assert.equal(res.error!.code, 403, `${method} should return 403`)
    }

    client.ws.close()
  } finally {
    await server.close()
  }
})

test('exec.run succeeds when allowExec=true', async () => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret', allowExec: true })
  try {
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open
    await authenticate(client.call, 'secret')

    const res = await client.call('exec.run', { command: 'printf hi' })
    assert.equal(res.error, undefined, `should succeed: ${JSON.stringify(res.error)}`)
    const r = res.result as any
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'hi')

    client.ws.close()
  } finally {
    await server.close()
  }
})

test('deny stub still requires authentication first (401 before 403)', async () => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret' })
  try {
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open

    // No authenticate call — exec.run must fail with 401
    const res = await client.call('exec.run', { command: 'echo hi' })
    assert.ok(res.error)
    assert.equal(res.error!.code, 401, 'unauthenticated should 401, not leak 403')

    client.ws.close()
  } finally {
    await server.close()
  }
})
