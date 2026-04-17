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

test('typora.eval is rejected with 403 when allowEval=false (default)', async () => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret' })
  try {
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open
    await authenticate(client.call, 'secret')

    const res = await client.call('typora.eval', { code: 'return 1 + 1' })
    assert.ok(res.error, 'must error')
    assert.equal(res.error!.code, 403, 'default-deny should return 403')
    assert.match(res.error!.message, /disabled by server policy/i)
    assert.match(res.error!.message, /allowEval=false/)

    client.ws.close()
  } finally {
    await server.close()
  }
})

test('typora.eval requires auth first — unauth callers see 401 not 403', async () => {
  // Critical: an unauthenticated probe must not be able to discover whether
  // eval is enabled by the 403 vs 401 message difference. Auth gate fires first.
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret' })
  try {
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open

    const res = await client.call('typora.eval', { code: 'return 1' })
    assert.ok(res.error)
    assert.equal(res.error!.code, 401, 'unauthenticated should 401, not leak 403')

    client.ws.close()
  } finally {
    await server.close()
  }
})

test('typora.eval with allowEval=true but no Typora session returns 503', async () => {
  // When the eval gate is open but no role=typora session is connected, the
  // sidecar cannot forward the eval — forwardTypora returns 503. This keeps
  // eval consistent with other typora.* methods.
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret', allowEval: true })
  try {
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open
    await authenticate(client.call, 'secret')

    const res = await client.call('typora.eval', { code: 'return 1' })
    assert.ok(res.error)
    assert.equal(res.error!.code, 503, `expected 503 when Typora offline; got ${JSON.stringify(res.error)}`)

    client.ws.close()
  } finally {
    await server.close()
  }
})

test('typora.eval with Typora session forwards and returns the evaluated result', async () => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret', allowEval: true })
  try {
    // Fake "typora" peer that handles typora.eval — simulates the plugin's
    // handler returning { result, async } after running vm.runInThisContext.
    const typoraWs = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      typoraWs.addEventListener('open', () => resolve(), { once: true })
      typoraWs.addEventListener('error', () => reject(new Error('typora ws error')), { once: true })
    })
    let nextTyporaId = 1
    const typoraPending = new Map<number, (env: RpcEnvelope) => void>()
    typoraWs.addEventListener('message', async (event) => {
      const msg = JSON.parse(String(event.data)) as RpcEnvelope & { method?: string; params?: any }
      // Incoming request from sidecar
      if (msg.method && msg.id != null) {
        if (msg.method === 'typora.eval') {
          const code = String((msg.params as any)?.code ?? '')
          // Simulate the real plugin: eval the code in a fake way
          // (safe here because we control the input in tests).
          const dummyResult = code === 'return 2 + 3' ? 5 : null
          typoraWs.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { result: dummyResult, async: false } }))
        }
        return
      }
      if (msg.id != null) typoraPending.get(Number(msg.id))?.(msg)
    })

    // authenticate typora side
    await new Promise<void>((resolve) => {
      const id = nextTyporaId++
      typoraPending.set(id, () => resolve())
      typoraWs.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'session.authenticate', params: { token: 'secret', role: 'typora' } }))
    })

    // Now call eval as a client
    const client = newClient(`ws://127.0.0.1:${server.port}/rpc`)
    await client.open
    await authenticate(client.call, 'secret')

    const res = await client.call('typora.eval', { code: 'return 2 + 3' })
    assert.equal(res.error, undefined, `no error expected: ${JSON.stringify(res.error)}`)
    assert.deepEqual(res.result, { result: 5, async: false })

    client.ws.close()
    typoraWs.close()
  } finally {
    await server.close()
  }
})
