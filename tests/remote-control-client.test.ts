import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TyporaRemoteControlClient, readLocalSettings } from '../clients/node/src/index.ts'
import { createSidecarServer } from '../plugins/remote-control/src/sidecar/server.ts'

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', event => reject(event), { once: true })
  })
}

function createTyporaMock(ws: WebSocket) {
  let nextId = 1
  const pending = new Map<number, (payload: unknown) => void>()
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()

  ws.addEventListener('message', async event => {
    const message = JSON.parse(String(event.data)) as {
      id?: number | string | null
      method?: string
      params?: unknown
      error?: unknown
      result?: unknown
    }

    if (typeof message.method === 'string' && message.id != null) {
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
    const pendingHandler = pending.get(Number(message.id))
    if (!pendingHandler) return
    pending.delete(Number(message.id))
    pendingHandler(message.result)
  })

  return {
    handle(method: string, handler: (params: unknown) => unknown | Promise<unknown>) {
      handlers.set(method, handler)
    },
    async call(method: string, params?: unknown): Promise<unknown> {
      const id = nextId++
      const response = new Promise<unknown>(resolve => {
        pending.set(id, resolve)
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      return await response
    },
  }
}

test('node client authenticates, runs commands, and consumes typora methods', async (t) => {
  const server = await createSidecarServer({ host: '127.0.0.1', port: 0, token: 'secret-token' })
  t.after(async () => {
    await server.close()
  })

  const typoraWs = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`)
  await waitForOpen(typoraWs)
  t.after(() => typoraWs.close())

  const typora = createTyporaMock(typoraWs)
  await typora.call('session.authenticate', {
    token: 'secret-token',
    role: 'typora',
  })
  typora.handle('typora.getContext', () => ({
    filePath: '/tmp/demo.md',
    fileName: 'demo.md',
    watchedFolder: '/tmp',
    sourceMode: false,
    hasUnsavedChanges: false,
    commands: [{ id: 'demo.run', name: 'Demo Run', pluginId: 'demo' }],
  }))
  typora.handle('typora.getDocument', () => ({
    filePath: '/tmp/demo.md',
    fileName: 'demo.md',
    markdown: '# demo',
  }))
  typora.handle('typora.plugins.list', () => [
    {
      id: 'note-assistant',
      name: 'Note Assistant',
      version: '0.1.0',
      description: 'Related notes',
      loading: { startup: true },
      loaded: true,
    },
    {
      id: 'wider',
      name: 'Wider',
      version: '0.1.0',
      description: 'Editor width',
      loading: { startup: true },
      loaded: true,
    },
  ])
  typora.handle('typora.plugins.setEnabled', params => ({
    pluginId: (params as { pluginId: string }).pluginId,
    enabled: Boolean((params as { enabled?: boolean }).enabled),
  }))
  typora.handle('typora.plugins.commands.list', params => {
    const pluginId = (params as { pluginId?: string } | undefined)?.pluginId
    const commands = [
      { id: 'note-assistant:open', name: 'Note Assistant: Open', pluginId: 'note-assistant' },
      { id: 'wider:set-wide', name: 'Editor Width: Wide', pluginId: 'wider' },
    ]
    return pluginId ? commands.filter(command => command.pluginId === pluginId) : commands
  })
  typora.handle('typora.plugins.commands.invoke', params => ({
    pluginId: (params as { pluginId: string }).pluginId,
    commandId: (params as { commandId: string }).commandId,
    result: { ok: true },
  }))
  typora.handle('typora.setSourceMode', params => ({
    sourceMode: Boolean((params as { enabled?: boolean }).enabled),
  }))
  typora.handle('typora.commands.list', () => [
    { id: 'demo.run', name: 'Demo Run', pluginId: 'demo' },
  ])
  typora.handle('typora.commands.invoke', params => ({
    commandId: (params as { commandId: string }).commandId,
    result: { ok: true },
  }))

  const client = await TyporaRemoteControlClient.connect({
    url: `ws://127.0.0.1:${server.port}/rpc`,
    token: 'secret-token',
  })
  t.after(() => client.close())

  assert.equal(await client.ping(), 'pong')

  const exec = await client.run('node -e "process.stdout.write(\'client-ok\')"')
  assert.equal(exec.exitCode, 0)
  assert.equal(exec.stdout, 'client-ok')

  const context = await client.getContext()
  assert.equal(context.fileName, 'demo.md')

  const documentState = await client.getDocument()
  assert.equal(documentState.markdown, '# demo')

  const sourceModeState = await client.setSourceMode(true)
  assert.deepEqual(sourceModeState, { sourceMode: true })

  const plugins = await client.listPlugins()
  assert.deepEqual(plugins.map(plugin => plugin.id), ['note-assistant', 'wider'])

  const pluginCommands = await client.listPluginCommands('note-assistant')
  assert.deepEqual(pluginCommands, [
    { id: 'note-assistant:open', name: 'Note Assistant: Open', pluginId: 'note-assistant' },
  ])

  const enabledState = await client.setPluginEnabled('note-assistant', false)
  assert.deepEqual(enabledState, {
    pluginId: 'note-assistant',
    enabled: false,
  })

  const commands = await client.listTyporaCommands()
  assert.deepEqual(commands, [
    { id: 'demo.run', name: 'Demo Run', pluginId: 'demo' },
  ])

  const invocation = await client.invokeTyporaCommand('demo.run')
  assert.deepEqual(invocation, {
    commandId: 'demo.run',
    result: { ok: true },
  })

  const pluginInvocation = await client.invokePluginCommand('note-assistant', 'note-assistant:open')
  assert.deepEqual(pluginInvocation, {
    pluginId: 'note-assistant',
    commandId: 'note-assistant:open',
    result: { ok: true },
  })

  const noteAssistantOpen = await client.noteAssistantOpen()
  assert.deepEqual(noteAssistantOpen, {
    pluginId: 'note-assistant',
    commandId: 'note-assistant:open',
    result: { ok: true },
  })

  const widerSetWide = await client.widerSetWide()
  assert.deepEqual(widerSetWide, {
    pluginId: 'wider',
    commandId: 'wider:set-wide',
    result: { ok: true },
  })

  const mdPaddingFormat = await client.mdPaddingFormat()
  assert.deepEqual(mdPaddingFormat, {
    pluginId: 'md-padding',
    commandId: 'md-padding:format',
    result: { ok: true },
  })
})

test('reads local settings file for convenient connection bootstrap', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'tpl-remote-control-'))
  const settingsPath = join(tempDir, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({
    host: '127.0.0.1',
    port: 5619,
    token: 'abc',
  }), 'utf8')

  const settings = await readLocalSettings(settingsPath)
  assert.deepEqual(settings, {
    host: '127.0.0.1',
    port: 5619,
    token: 'abc',
  })
})
