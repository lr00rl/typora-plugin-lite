import test from 'node:test'
import assert from 'node:assert/strict'

import { createSidecarServer } from '../plugins/remote-control/src/sidecar/server.ts'

interface RpcEnvelope {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (event) => reject(event), { once: true })
  })
}

function createRpcClient(ws: WebSocket) {
  let nextId = 1
  const pending = new Map<number, { resolve: (value: RpcEnvelope) => void; reject: (error: unknown) => void }>()
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()

  ws.addEventListener('message', async (event) => {
    const message = JSON.parse(String(event.data)) as RpcEnvelope

    if (message.id != null && message.method) {
      const handler = handlers.get(message.method)
      if (!handler) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `No handler for ${message.method}` },
        }))
        return
      }

      try {
        const result = await handler(message.params)
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      } catch (error) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        }))
      }
        return
    }

    if (message.id == null) return
    const entry = pending.get(Number(message.id))
    if (!entry) return
    pending.delete(Number(message.id))
    entry.resolve(message)
  })

  return {
    handle(method: string, handler: (params: unknown) => unknown | Promise<unknown>) {
      handlers.set(method, handler)
    },
    async callRaw(method: string, params?: unknown): Promise<RpcEnvelope> {
      const id = nextId++
      const payload = { jsonrpc: '2.0', id, method, params }
      const response = new Promise<RpcEnvelope>((resolve, reject) => {
        pending.set(id, { resolve, reject })
      })
      ws.send(JSON.stringify(payload))
      return await response
    },
    async call<T>(method: string, params?: unknown): Promise<T> {
      const response = await this.callRaw(method, params)
      if (response.error) {
        throw new Error(`${response.error.code}:${response.error.message}`)
      }
      return response.result as T
    },
  }
}

test('rejects unauthenticated calls', async (t) => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret-token' })
  t.after(async () => {
    await server.close()
  })

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`)
  await waitForOpen(ws)
  t.after(() => ws.close())

  const client = createRpcClient(ws)
  const response = await client.callRaw('system.ping')

  assert.equal(response.error?.code, 401)
  assert.match(response.error?.message ?? '', /Unauthenticated/)
})

test('authenticates and executes short-lived commands', async (t) => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret-token' })
  t.after(async () => {
    await server.close()
  })

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`)
  await waitForOpen(ws)
  t.after(() => ws.close())

  const client = createRpcClient(ws)
  const auth = await client.call<{ authenticated: boolean; role: string }>('session.authenticate', {
    token: 'secret-token',
    role: 'client',
  })
  assert.equal(auth.authenticated, true)
  assert.equal(auth.role, 'client')

  const pong = await client.call<string>('system.ping')
  assert.equal(pong, 'pong')

  const result = await client.call<{ exitCode: number; stdout: string; stderr: string }>('exec.run', {
    command: 'node -e "process.stdout.write(\'ok\')"',
    timeoutMs: 5_000,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'ok')
  assert.equal(result.stderr, '')
})

test('proxies typora-scoped requests through the authenticated typora session', async (t) => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret-token' })
  t.after(async () => {
    await server.close()
  })

  const typoraWs = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`)
  await waitForOpen(typoraWs)
  t.after(() => typoraWs.close())
  const typora = createRpcClient(typoraWs)
  await typora.call('session.authenticate', {
    token: 'secret-token',
    role: 'typora',
  })
  typora.handle('typora.getDocument', () => ({
    markdown: '# hello',
    filePath: '/tmp/example.md',
    fileName: 'example.md',
  }))

  const clientWs = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`)
  await waitForOpen(clientWs)
  t.after(() => clientWs.close())
  const client = createRpcClient(clientWs)
  await client.call('session.authenticate', {
    token: 'secret-token',
    role: 'client',
  })

  const documentState = await client.call<{ markdown: string; filePath: string }>('typora.getDocument')
  assert.equal(documentState.markdown, '# hello')
  assert.equal(documentState.filePath, '/tmp/example.md')
})
