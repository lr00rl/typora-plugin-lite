import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

type NotificationHandler = (params: unknown) => void

interface JsonRpcEnvelope {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface ConnectionOptions {
  url: string
  token: string
  role?: 'client' | 'typora'
}

interface LocalSettings {
  host: string
  port: number
  token: string
}

export interface ExecRunResult {
  command: string
  cwd?: string
  exitCode: number
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface ExecStartResult {
  execId: string
  pid: number
  command: string
  cwd?: string
}

export interface ExecListEntry {
  execId: string
  ownerSessionId: string
  command: string
  cwd: string | null
  pid: number
  startedAt: number
}

export interface TyporaContext {
  filePath: string
  fileName: string
  watchedFolder: string | null
  sourceMode: boolean
  hasUnsavedChanges: boolean
  commands: Array<{ id: string; name: string; pluginId: string | null }>
}

export interface TyporaDocument {
  filePath: string
  fileName: string
  markdown: string
}

export class TyporaRemoteControlError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export class TyporaRemoteControlClient {
  private readonly ws: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
  }>()
  private readonly handlers = new Map<string, Set<NotificationHandler>>()
  private closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', event => {
      this.handleMessage(String(event.data))
    })
    ws.addEventListener('close', () => {
      this.closed = true
      const error = new Error('Remote control socket closed')
      for (const pending of this.pending.values()) {
        pending.reject(error)
      }
      this.pending.clear()
    })
  }

  static async connect(options: ConnectionOptions): Promise<TyporaRemoteControlClient> {
    const role = options.role ?? 'client'
    const ws = new WebSocket(options.url)

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error(`Failed to connect to ${options.url}`)), { once: true })
    })

    const client = new TyporaRemoteControlClient(ws)
    await client.call('session.authenticate', {
      token: options.token,
      role,
    })
    return client
  }

  static async connectFromLocalSettings(options: {
    settingsPath?: string
    role?: 'client' | 'typora'
  } = {}): Promise<TyporaRemoteControlClient> {
    const settings = await readLocalSettings(options.settingsPath)
    return await TyporaRemoteControlClient.connect({
      url: `ws://${settings.host}:${settings.port}/rpc`,
      token: settings.token,
      role: options.role,
    })
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw new Error('Remote control socket is closed')
    }

    const id = this.nextId++
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
      })
    })

    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }))

    return await response
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    if (!this.handlers.has(method)) {
      this.handlers.set(method, new Set())
    }
    this.handlers.get(method)!.add(handler)
    return () => {
      this.handlers.get(method)?.delete(handler)
    }
  }

  close(): void {
    this.closed = true
    this.ws.close()
  }

  async ping(): Promise<string> {
    return await this.call('system.ping')
  }

  async getInfo(): Promise<{
    pid: number
    host: string
    port: number
    typoraConnected: boolean
    sessionCount: number
    execCount: number
  }> {
    return await this.call('system.getInfo')
  }

  async shutdown(): Promise<{ stopping: boolean }> {
    return await this.call('system.shutdown')
  }

  async run(command: string, options: {
    cwd?: string
    timeoutMs?: number
    maxBytes?: number
  } = {}): Promise<ExecRunResult> {
    return await this.call('exec.run', {
      command,
      ...options,
    })
  }

  async start(command: string, options: {
    cwd?: string
  } = {}): Promise<ExecStartResult> {
    return await this.call('exec.start', {
      command,
      ...options,
    })
  }

  async kill(execId: string, signal?: string): Promise<{ execId: string; killed: boolean }> {
    return await this.call('exec.kill', {
      execId,
      ...(signal ? { signal } : {}),
    })
  }

  async listExecs(): Promise<ExecListEntry[]> {
    return await this.call('exec.list')
  }

  async getContext(): Promise<TyporaContext> {
    return await this.call('typora.getContext')
  }

  async getDocument(): Promise<TyporaDocument> {
    return await this.call('typora.getDocument')
  }

  async setDocument(markdown: string): Promise<TyporaDocument> {
    return await this.call('typora.setDocument', { markdown })
  }

  async insertText(text: string): Promise<{ inserted: boolean }> {
    return await this.call('typora.insertText', { text })
  }

  async openFile(filePath: string): Promise<TyporaContext> {
    return await this.call('typora.openFile', { filePath })
  }

  async listTyporaCommands(): Promise<TyporaContext['commands']> {
    return await this.call('typora.commands.list')
  }

  async invokeTyporaCommand(commandId: string): Promise<{ commandId: string; result: unknown }> {
    return await this.call('typora.commands.invoke', { commandId })
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as JsonRpcEnvelope
    if (message.jsonrpc !== '2.0') return

    if (typeof message.method === 'string' && message.id == null) {
      const handlers = this.handlers.get(message.method)
      if (!handlers) return
      for (const handler of handlers) {
        handler(message.params)
      }
      return
    }

    if (message.id == null) return

    const pending = this.pending.get(Number(message.id))
    if (!pending) return
    this.pending.delete(Number(message.id))

    if (message.error) {
      pending.reject(new TyporaRemoteControlError(
        message.error.code,
        message.error.message,
        message.error.data,
      ))
      return
    }

    pending.resolve(message.result)
  }
}

export async function readLocalSettings(settingsPath = getDefaultSettingsPath()): Promise<LocalSettings> {
  const raw = JSON.parse(await readFile(settingsPath, 'utf8')) as Partial<LocalSettings>
  if (!raw.host || !raw.port || !raw.token) {
    throw new Error(`Incomplete remote-control settings at ${settingsPath}`)
  }
  return {
    host: raw.host,
    port: raw.port,
    token: raw.token,
  }
}

export function getDefaultSettingsPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'abnerworks.Typora', 'plugins', 'data', 'remote-control', 'settings.json')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'Typora', 'plugins', 'data', 'remote-control', 'settings.json')
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(xdgConfig, 'Typora', 'plugins', 'data', 'remote-control', 'settings.json')
}
