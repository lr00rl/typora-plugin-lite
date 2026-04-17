import { Plugin, editor, getApp, platform, IS_NODE } from '@typora-plugin-lite/core'

import { JsonRpcPeer, JsonRpcRemoteError } from './rpc/json-rpc.js'

interface RemoteControlSettings extends Record<string, unknown> {
  enabled: boolean
  host: string
  port: number
  token: string
  nodePath: string
  logPath: string
}

interface ServiceState {
  sidecarStarted: boolean
  socketConnected: boolean
}

const DEFAULT_SETTINGS: RemoteControlSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: 5619,
  token: '',
  nodePath: '',
  logPath: '',
}

const STATUS_CMD = 'remote-control:show-status'
const START_CMD = 'remote-control:start-service'
const STOP_CMD = 'remote-control:stop-service'
const COPY_TOKEN_CMD = 'remote-control:copy-token'
const COPY_URL_CMD = 'remote-control:copy-url'

export default class RemoteControlPlugin extends Plugin<RemoteControlSettings> {
  private socket: WebSocket | null = null
  private rpc: JsonRpcPeer | null = null
  private state: ServiceState = { sidecarStarted: false, socketConnected: false }

  _init(...args: Parameters<Plugin<RemoteControlSettings>['_init']>): void {
    super._init(args[0], args[1], DEFAULT_SETTINGS)
  }

  async onload(): Promise<void> {
    await this.ensureToken()
    this.registerCommands()
    this.addDisposable(() => {
      this.disconnect()
    })
    void this.enableService().catch(error => {
      console.error('[tpl:remote-control]', error)
      this.showNotice(error instanceof Error ? error.message : 'Remote control failed to start', 6000)
    })
  }

  onunload(): void {
    void this.stopService({
      persistEnabled: false,
      showNotice: false,
    })
  }

  private registerCommands(): void {
    this.registerCommand({
      id: STATUS_CMD,
      name: 'Remote Control: Show Status',
      callback: () => void this.showStatus(),
    })
    this.registerCommand({
      id: START_CMD,
      name: 'Remote Control: Start Local Service',
      callback: () => void this.enableService(),
    })
    this.registerCommand({
      id: STOP_CMD,
      name: 'Remote Control: Stop Local Service',
      callback: () => void this.disableService(),
    })
    this.registerCommand({
      id: COPY_TOKEN_CMD,
      name: 'Remote Control: Copy Bearer Token',
      callback: () => void this.copyToken(),
    })
    this.registerCommand({
      id: COPY_URL_CMD,
      name: 'Remote Control: Copy WebSocket URL',
      callback: () => void this.copyUrl(),
    })
  }

  private async ensureToken(): Promise<void> {
    if (this.settings.get('token')) return
    this.settings.set('token', randomToken())
    await this.settings.save()
  }

  private async enableService(): Promise<void> {
    this.settings.set('enabled', true)
    await this.settings.save()
    await this.ensureSidecar()
    await this.connectRpc()
    this.showNotice('Remote control service started')
  }

  private async disableService(): Promise<void> {
    await this.stopService({
      persistEnabled: true,
      showNotice: true,
    })
  }

  private async stopService(options: {
    persistEnabled: boolean
    showNotice: boolean
  }): Promise<void> {
    if (options.persistEnabled) {
      this.settings.set('enabled', false)
      await this.settings.save()
    }

    try {
      if (this.rpc) {
        await this.rpc.request('system.shutdown')
      }
    } catch {}

    this.disconnect()
    this.state.sidecarStarted = false
    if (options.showNotice) {
      this.showNotice('Remote control service stopped')
    }
  }

  private async copyToken(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.settings.get('token'))
      this.showNotice('Remote control token copied')
    } catch {
      this.showNotice('Failed to copy remote control token')
    }
  }

  private async copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.getWsUrl())
      this.showNotice('Remote control URL copied')
    } catch {
      this.showNotice('Failed to copy remote control URL')
    }
  }

  private async showStatus(): Promise<void> {
    const details = [
      `enabled=${this.settings.get('enabled') ? 'yes' : 'no'}`,
      `url=${this.getWsUrl()}`,
      `socket=${this.state.socketConnected ? 'connected' : 'disconnected'}`,
      `sidecar=${this.state.sidecarStarted ? 'running' : 'stopped'}`,
      `token=${maskToken(this.settings.get('token'))}`,
    ]
    this.showNotice(details.join(' · '), 6000)
  }

  private async ensureSidecar(): Promise<void> {
    if (await this.pingSidecar()) {
      this.state.sidecarStarted = true
      return
    }

    const nodePath = await this.resolveNodePath()
    const sidecarPath = this.getSidecarPath()
    const host = this.settings.get('host')
    const port = this.settings.get('port')
    const token = this.settings.get('token')
    const logPath = this.getLogPath()

    await platform.fs.mkdir(platform.path.dirname(logPath))

    if (IS_NODE) {
      const cp = window.reqnode!('child_process')
      const fs = window.reqnode!('fs')
      const out = fs.openSync(logPath, 'a')
      const child = cp.spawn(nodePath, [
        sidecarPath,
        '--host',
        host,
        '--port',
        String(port),
        '--token',
        token,
      ], {
        detached: true,
        stdio: ['ignore', out, out],
      })
      child.unref()
    } else {
      const cmd = [
        'nohup',
        platform.shell.escape(nodePath),
        platform.shell.escape(sidecarPath),
        '--host',
        platform.shell.escape(host),
        '--port',
        platform.shell.escape(String(port)),
        '--token',
        platform.shell.escape(token),
        '>>',
        platform.shell.escape(logPath),
        '2>&1',
        '&',
      ].join(' ')
      await platform.shell.run(cmd, { timeout: 10_000 })
    }

    const started = await waitFor(async () => await this.pingSidecar(), 5000)
    if (!started) {
      throw new Error('Remote control sidecar failed to start')
    }
    this.state.sidecarStarted = true
  }

  private async connectRpc(): Promise<void> {
    if (this.state.socketConnected && this.socket && this.rpc) return

    this.disconnect()

    const socket = new WebSocket(this.getWsUrl())
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('Failed to connect remote-control socket')), { once: true })
    })

    const rpc = new JsonRpcPeer(payload => {
      socket.send(payload)
    })
    socket.addEventListener('message', event => {
      rpc.handleMessage(String(event.data))
    })
    socket.addEventListener('close', () => {
      this.state.socketConnected = false
      rpc.failPending(new Error('Remote control socket closed'))
    })

    await rpc.request('session.authenticate', {
      token: this.settings.get('token'),
      role: 'typora',
    })

    rpc.registerMethod('typora.getContext', async () => this.getContext())
    rpc.registerMethod('typora.getDocument', async () => this.getDocument())
    rpc.registerMethod('typora.setDocument', async (params) => {
      const input = asRecord(params)
      const markdown = expectString(input.markdown, 'markdown')
      editor.setMarkdown(markdown)
      return this.getDocument()
    })
    rpc.registerMethod('typora.insertText', async (params) => {
      const input = asRecord(params)
      const text = expectString(input.text, 'text')
      editor.insertText(text)
      return { inserted: true }
    })
    rpc.registerMethod('typora.openFile', async (params) => {
      const input = asRecord(params)
      const filePath = expectString(input.filePath, 'filePath')
      await editor.openFile(filePath)
      return this.getContext()
    })
    rpc.registerMethod('typora.commands.list', async () => {
      return getApp().commands.list()
    })
    rpc.registerMethod('typora.commands.invoke', async (params) => {
      const input = asRecord(params)
      const commandId = expectString(input.commandId, 'commandId')
      const result = await getApp().commands.execute(commandId)
      return { commandId, result: result ?? null }
    })

    this.socket = socket
    this.rpc = rpc
    this.state.socketConnected = true
  }

  private disconnect(): void {
    this.state.socketConnected = false
    this.rpc?.failPending(new Error('Remote control disconnected'))
    this.rpc = null
    this.socket?.close()
    this.socket = null
  }

  private async pingSidecar(): Promise<boolean> {
    try {
      const socket = new WebSocket(this.getWsUrl())
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true })
        socket.addEventListener('error', () => reject(new Error('connect failed')), { once: true })
      })

      const rpc = new JsonRpcPeer(payload => {
        socket.send(payload)
      })
      socket.addEventListener('message', event => {
        rpc.handleMessage(String(event.data))
      })

      await rpc.request('session.authenticate', {
        token: this.settings.get('token'),
        role: 'client',
      })
      const pong = await rpc.request<string>('system.ping')
      socket.close()
      return pong === 'pong'
    } catch {
      return false
    }
  }

  private async resolveNodePath(): Promise<string> {
    const configured = this.settings.get('nodePath')
    if (configured) return configured

    if (IS_NODE) {
      const cp = window.reqnode!('child_process')
      const processRef = (window as any).process as NodeJS.Process | undefined
      const pathEntries = (processRef?.env?.PATH ?? '').split(processRef?.platform === 'win32' ? ';' : ':').filter(Boolean)

      for (const candidate of ['node', 'node.exe']) {
        try {
          const result = await new Promise<string>((resolve, reject) => {
            cp.execFile(candidate, ['-v'], (error, stdout) => {
              if (error) reject(error)
              else resolve(stdout.toString().trim())
            })
          })
          if (result) return candidate
        } catch {}
      }

      for (const entry of pathEntries) {
        for (const candidate of ['node', 'node.exe']) {
          const absolute = platform.path.join(entry, candidate)
          const exists = await platform.fs.exists(absolute)
          if (exists) {
            return absolute
          }
        }
      }
    }

    const detected = (await platform.shell.run(
      'command -v node || which node || ls -1 /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -n 1',
      { timeout: 5000 },
    )).trim()
    if (detected) return detected

    throw new Error('No external Node.js runtime found. Configure remote-control.nodePath first.')
  }

  private getSidecarPath(): string {
    return platform.path.join(platform.builtinPluginsDir, 'remote-control', 'bin', 'sidecar.mjs')
  }

  private getLogPath(): string {
    const custom = this.settings.get('logPath')
    if (custom) return custom
    return platform.path.join(platform.dataDir, 'remote-control', 'logs', 'sidecar.log')
  }

  private getWsUrl(): string {
    return `ws://${this.settings.get('host')}:${this.settings.get('port')}/rpc`
  }

  private getContext() {
    return {
      filePath: editor.getFilePath(),
      fileName: editor.getFileName(),
      watchedFolder: editor.getWatchedFolder() ?? null,
      sourceMode: editor.isSourceMode(),
      hasUnsavedChanges: editor.hasUnsavedChanges(),
      commands: getApp().commands.list(),
    }
  }

  private getDocument() {
    return {
      filePath: editor.getFilePath(),
      fileName: editor.getFileName(),
      markdown: editor.getMarkdown(),
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new JsonRpcRemoteError(-32602, `Invalid ${field}`)
  }
  return value
}

function randomToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function maskToken(token: string): string {
  if (token.length <= 8) return token
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return false
}
