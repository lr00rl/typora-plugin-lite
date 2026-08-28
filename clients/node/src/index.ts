import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import WebSocket from 'ws'

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 35_000
const OPERATION_TIMEOUT_GRACE_MS = 5_000

type NotificationHandler = (params: unknown) => void

interface JsonRpcEnvelope {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface ConnectionOptions {
  url: string
  token: string
  role?: 'client' | 'typora'
  /** Time allowed for the TCP/WebSocket handshake and authentication. */
  connectTimeoutMs?: number
  /** Default transport timeout for each JSON-RPC request. Set 0 to disable. */
  requestTimeoutMs?: number
}

export interface RpcCallOptions {
  /** Override the client's default transport timeout for this request. */
  timeoutMs?: number
}

export interface LocalSettings {
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

export interface RpcMethodInfo {
  name: string
  tier: 'open' | 'auth' | 'typora' | 'exec' | 'eval'
  summary: string
  params?: string
  available: boolean
  unavailableReason: string | null
}

export interface TyporaSelection {
  text: string
  hasSelection: boolean
}

export interface TyporaEvalResult {
  result: unknown
  async: boolean
}

export interface TyporaContext {
  filePath: string
  fileName: string
  mountFolder: string
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

export interface TyporaSourceModeState {
  sourceMode: boolean
}

export interface TyporaPluginDescriptor {
  id: string
  name: string
  version: string
  description: string
  loading: {
    startup?: boolean
    event?: string[]
    hotkey?: string[]
  }
  loaded: boolean
}

export interface TyporaPluginEnabledState {
  pluginId: string
  enabled: boolean
}

export interface TyporaPluginCommandResult {
  pluginId: string
  commandId: string
  result: unknown
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
    timer?: ReturnType<typeof setTimeout>
  }>()
  private readonly handlers = new Map<string, Set<NotificationHandler>>()
  private readonly requestTimeoutMs: number
  private closed = false

  private constructor(ws: WebSocket, requestTimeoutMs: number) {
    this.ws = ws
    this.requestTimeoutMs = requestTimeoutMs
    ws.addEventListener('message', event => {
      this.handleMessage(String(event.data))
    })
    ws.addEventListener('close', event => {
      this.closed = true
      const reason = event.reason ? `: ${event.reason}` : ''
      this.failPending(new Error(`Remote control socket closed (${event.code})${reason}`))
    })
    ws.addEventListener('error', () => {
      if (this.closed) return
      this.closed = true
      this.failPending(new Error('Remote control socket error'))
      ws.close()
    })
  }

  static async connect(options: ConnectionOptions): Promise<TyporaRemoteControlClient> {
    const role = options.role ?? 'client'
    const connectTimeoutMs = normalizeTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS)
    const requestTimeoutMs = normalizeTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
    const ws = new WebSocket(options.url)

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          ws.removeEventListener('open', onOpen)
          ws.removeEventListener('error', onError)
          error ? reject(error) : resolve()
        }
        const onOpen = () => finish()
        const onError = () => finish(new Error(`Failed to connect to ${options.url}`))
        const timer = setTimeout(() => {
          finish(new Error(`Connection timed out after ${connectTimeoutMs}ms: ${options.url}`))
        }, connectTimeoutMs)
        ws.addEventListener('open', onOpen, { once: true })
        ws.addEventListener('error', onError, { once: true })
      })
    } catch (error) {
      ws.terminate()
      throw error
    }

    const client = new TyporaRemoteControlClient(ws, requestTimeoutMs)
    try {
      await client.call('session.authenticate', {
        token: options.token,
        role,
      }, { timeoutMs: connectTimeoutMs })
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  static async connectFromLocalSettings(options: {
    settingsPath?: string
    role?: 'client' | 'typora'
    connectTimeoutMs?: number
    requestTimeoutMs?: number
  } = {}): Promise<TyporaRemoteControlClient> {
    const settings = await readLocalSettings(options.settingsPath)
    return await TyporaRemoteControlClient.connect({
      url: `ws://${settings.host}:${settings.port}/rpc`,
      token: settings.token,
      role: options.role,
      connectTimeoutMs: options.connectTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
    })
  }

  async call<T>(method: string, params?: unknown, options: RpcCallOptions = {}): Promise<T> {
    if (this.closed) {
      throw new Error('Remote control socket is closed')
    }

    const id = this.nextId++
    const response = new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (!this.pending.has(id)) return
            this.pending.delete(id)
            reject(new TyporaRemoteControlError(
              -32001,
              `Request timed out after ${timeoutMs}ms: ${method}`,
            ))
          }, timeoutMs)
        : undefined
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      })
    })

    try {
      this.ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }))
    } catch (error) {
      const pending = this.pending.get(id)
      this.pending.delete(id)
      if (pending?.timer) clearTimeout(pending.timer)
      pending?.reject(error)
    }

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
    if (this.closed) return
    this.closed = true
    this.failPending(new Error('Remote control socket closed by client'))
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

  /**
   * Introspect the RPC surface: every method, its authorization tier, param
   * hint, and whether it is reachable right now given the sidecar's policy and
   * whether Typora is connected. Point of first contact for an agent that
   * doesn't already know the method names.
   */
  async listMethods(): Promise<{ methods: RpcMethodInfo[] }> {
    return await this.call('system.listMethods')
  }

  async run(command: string, options: {
    cwd?: string
    timeoutMs?: number
    maxBytes?: number
  } = {}): Promise<ExecRunResult> {
    return await this.call('exec.run', {
      command,
      ...options,
    }, { timeoutMs: this.operationTimeout(options.timeoutMs) })
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

  /** The user's current selection in Typora. */
  async getSelection(): Promise<TyporaSelection> {
    return await this.call('typora.getSelection')
  }

  /**
   * Evaluate JavaScript in the Typora renderer. Requires the sidecar to have
   * been started with allowEval=true, else rejects 403. `async: true` lets the
   * snippet use `await`; `timeoutMs` bounds the wait.
   */
  async eval(code: string, options: { async?: boolean; timeoutMs?: number } = {}): Promise<TyporaEvalResult> {
    return await this.call(
      'typora.eval',
      { code, ...options },
      { timeoutMs: this.operationTimeout(options.timeoutMs) },
    )
  }

  async setSourceMode(enabled: boolean): Promise<TyporaSourceModeState> {
    return await this.call('typora.setSourceMode', { enabled })
  }

  async insertText(text: string): Promise<{ inserted: boolean }> {
    return await this.call('typora.insertText', { text })
  }

  async openFile(filePath: string): Promise<TyporaContext> {
    return await this.call('typora.openFile', { filePath })
  }

  async openFolder(folderPath: string): Promise<TyporaContext> {
    return await this.call('typora.openFolder', { folderPath })
  }

  async listTyporaCommands(): Promise<TyporaContext['commands']> {
    return await this.call('typora.commands.list')
  }

  async invokeTyporaCommand(commandId: string): Promise<{ commandId: string; result: unknown }> {
    return await this.call('typora.commands.invoke', { commandId })
  }

  async listPlugins(): Promise<TyporaPluginDescriptor[]> {
    return await this.call('typora.plugins.list')
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<TyporaPluginEnabledState> {
    return await this.call('typora.plugins.setEnabled', { pluginId, enabled })
  }

  async listPluginCommands(pluginId?: string): Promise<TyporaContext['commands']> {
    return await this.call('typora.plugins.commands.list', pluginId ? { pluginId } : {})
  }

  async invokePluginCommand(pluginId: string, commandId: string): Promise<TyporaPluginCommandResult> {
    return await this.call('typora.plugins.commands.invoke', { pluginId, commandId })
  }

  async noteAssistantOpen(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('note-assistant', 'note-assistant:open')
  }

  async noteAssistantRebuildGraph(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('note-assistant', 'note-assistant:rebuild-graph')
  }

  async noteAssistantState(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('note-assistant', 'note-assistant:state')
  }

  async widerCycle(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('wider', 'wider:cycle')
  }

  async widerSetDefault(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('wider', 'wider:set-default')
  }

  async widerSetWide(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('wider', 'wider:set-wide')
  }

  async widerSetFull(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('wider', 'wider:set-full')
  }

  async widerNarrower(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('wider', 'wider:narrower')
  }

  async widerWider(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('wider', 'wider:wider')
  }

  async mdPaddingFormat(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('md-padding', 'md-padding:format')
  }

  async titleShiftIncrease(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('title-shift', 'title-shift:increase')
  }

  async titleShiftDecrease(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('title-shift', 'title-shift:decrease')
  }

  async quickOpenInstallFzf(): Promise<TyporaPluginCommandResult> {
    return await this.invokePluginCommand('fuzzy-search', 'quick-open:install-fzf')
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcEnvelope
    try {
      message = JSON.parse(raw) as JsonRpcEnvelope
    } catch {
      return
    }
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
    if (pending.timer) clearTimeout(pending.timer)

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

  private operationTimeout(operationTimeoutMs?: number): number {
    return operationTimeoutMs && operationTimeoutMs > 0
      ? Math.max(this.requestTimeoutMs, operationTimeoutMs + OPERATION_TIMEOUT_GRACE_MS)
      : this.requestTimeoutMs
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export async function readLocalSettings(settingsPath?: string): Promise<LocalSettings> {
  const candidates = settingsPath ? [settingsPath] : getDefaultSettingsPaths()
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(await readFile(candidate, 'utf8')) as Partial<LocalSettings>
      if (!raw.host || !raw.port || !raw.token) {
        throw new Error(`Incomplete remote-control settings at ${candidate}`)
      }
      return {
        host: raw.host,
        port: raw.port,
        token: raw.token,
      }
    } catch (error) {
      if (isFileNotFound(error) && !settingsPath) continue
      throw error
    }
  }
  throw new Error(`Remote-control settings not found. Tried: ${candidates.join(', ')}`)
}

export function getDefaultSettingsPath(): string {
  return getDefaultSettingsPaths()[0]!
}

export function getDefaultSettingsPaths(): string[] {
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library', 'Application Support', 'abnerworks.Typora', 'plugins', 'data', 'remote-control', 'settings.json')]
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return [
      join(appData, 'Typora', 'plugins', 'data', 'remote-control', 'settings.json'),
      join(homedir(), 'plugins', 'data', 'remote-control', 'settings.json'),
    ]
  }
  return [join(homedir(), '.local', 'Typora', 'data', 'remote-control', 'settings.json')]
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
