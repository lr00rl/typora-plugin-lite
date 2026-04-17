import { Plugin, editor, getApp, platform, IS_NODE, type SettingsSchema } from '@typora-plugin-lite/core'

import { JsonRpcPeer, JsonRpcRemoteError } from './rpc/json-rpc.js'

interface RemoteControlSettings extends Record<string, unknown> {
  enabled: boolean
  host: string
  port: number
  token: string
  nodePath: string
  logPath: string
  /**
   * Default-deny shell execution. Required for exec.run / exec.start / exec.list /
   * exec.kill RPC methods. Leave off unless you trust every client that can
   * connect to the loopback sidecar.
   */
  allowExec: boolean
  /**
   * Default-deny arbitrary JavaScript evaluation in the Typora renderer.
   * Required for the `typora.eval` RPC. This is strictly more powerful than
   * allowExec — a granted eval surface can spawn shells via `require('child_process')`
   * regardless of the allowExec setting, and can read/write any Typora state.
   * Only enable for trusted loopback-only use on personal machines.
   */
  allowEval: boolean
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
  allowExec: false,
  allowEval: false,
}

const STATUS_CMD = 'remote-control:show-status'
const START_CMD = 'remote-control:start-service'
const STOP_CMD = 'remote-control:stop-service'
const COPY_TOKEN_CMD = 'remote-control:copy-token'
const COPY_URL_CMD = 'remote-control:copy-url'

/**
 * Settings whose change requires a fresh sidecar process (the sidecar reads
 * them once at startup). Editing any of these in the Plugin Center triggers
 * `scheduleRestart()`.
 */
const RESTART_KEYS = new Set(['allowExec', 'allowEval', 'host', 'port', 'token'])
const RESTART_DEBOUNCE_MS = 500

export default class RemoteControlPlugin extends Plugin<RemoteControlSettings> {
  static settingsSchema: SettingsSchema<RemoteControlSettings> = {
    fields: {
      host: {
        kind: 'string',
        label: 'Host',
        description: 'Bind address. Keep 127.0.0.1 for loopback-only; LAN exposure is not supported.',
        section: 'Network',
        monospace: true,
        validate: (v) => v.length === 0 ? 'Host is required' : null,
      },
      port: {
        kind: 'number',
        label: 'Port',
        description: 'TCP port for the sidecar WebSocket (JSON-RPC).',
        section: 'Network',
        min: 1024,
        max: 65535,
        validate: (v) => (!Number.isInteger(v) ? 'Port must be an integer' : null),
      },
      token: {
        kind: 'secret',
        label: 'Bearer token',
        description: 'Automatically generated on first launch. Clients must present this token to authenticate.',
        section: 'Security',
        regenerate: () => randomToken(),
      },
      allowExec: {
        kind: 'toggle',
        label: 'Allow shell execution (DANGEROUS)',
        description: 'Required for exec.run / exec.start RPC methods. Off by default — enable only if you trust every client. Toggling restarts the sidecar.',
        section: 'Security',
        dangerous: true,
      },
      allowEval: {
        kind: 'toggle',
        label: 'Allow JS evaluation in Typora (MAXIMALLY DANGEROUS)',
        description: 'Required for the typora.eval RPC. Strictly stronger than allowExec — JS in the renderer can spawn shells via require("child_process") regardless of the allowExec setting. Only enable on personal machines; never in shared or server contexts. Toggling restarts the sidecar.',
        section: 'Security',
        dangerous: true,
      },
      nodePath: {
        kind: 'path',
        label: 'Node.js path',
        description: 'Absolute path to a node binary. Leave blank to auto-detect from PATH.',
        section: 'Advanced',
        placeholder: '(auto-detected)',
      },
      logPath: {
        kind: 'path',
        label: 'Sidecar log file',
        description: 'Where the sidecar appends stdout/stderr. Leave blank to use the default under dataDir.',
        section: 'Advanced',
        placeholder: '(default: <dataDir>/remote-control/logs/sidecar.log)',
      },
    },
    sections: {
      Network:  { title: 'Network',  order: 1 },
      Security: { title: 'Security', order: 2 },
      Advanced: { title: 'Advanced', order: 3 },
    },
    order: ['host', 'port', 'token', 'allowExec', 'allowEval', 'nodePath', 'logPath'],
  }

  static defaultSettings: RemoteControlSettings = { ...DEFAULT_SETTINGS }

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

    // Auto-restart the sidecar when settings that affect the process lifecycle
    // change — flipping allowExec, rebinding host/port, or regenerating the
    // token all require a fresh sidecar to take effect. Debounced so rapid
    // successive edits in the Plugin Center coalesce into one restart.
    this.addDisposable(this.settings.onChange((key) => {
      if (!RESTART_KEYS.has(String(key))) return
      this.scheduleRestart()
    }))

    void this.enableService().catch(error => {
      console.error('[tpl:remote-control]', error)
      this.showNotice(error instanceof Error ? error.message : 'Remote control failed to start', 6000)
    })
  }

  onunload(): void {
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    void this.stopService({
      persistEnabled: false,
      showNotice: false,
    })
  }

  private restartTimer: number | null = null

  /** Debounce rapid settings edits then bounce the sidecar. */
  private scheduleRestart(): void {
    if (!this.state.sidecarStarted) return
    if (this.restartTimer !== null) window.clearTimeout(this.restartTimer)
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null
      void this.restartService()
    }, RESTART_DEBOUNCE_MS)
  }

  private async restartService(): Promise<void> {
    try {
      await this.stopService({ persistEnabled: true, showNotice: false })
      await this.enableService()
      this.showNotice('Remote control restarted to apply settings', 4000)
    } catch (err) {
      console.error('[tpl:remote-control] restart failed:', err)
      this.showNotice('Remote control restart failed — see console', 6000)
    }
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
    await this.retireStaleSidecarIfAny()

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

    // Parent PID for sidecar liveness watchdog. In Electron renderers,
    // process.ppid is the main (host-app) process — exactly the lifetime we
    // want the sidecar tied to. Fall back to renderer pid, then 0 (watcher
    // skips invalid pids).
    const parentPid = this.resolveParentPid()

    const allowExec = this.settings.get('allowExec') ? '1' : '0'
    const allowEval = this.settings.get('allowEval') ? '1' : '0'

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
        '--parent-pid',
        String(parentPid),
        '--allow-exec',
        allowExec,
        '--allow-eval',
        allowEval,
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
        '--parent-pid',
        platform.shell.escape(String(parentPid)),
        '--allow-exec',
        allowExec,
        '--allow-eval',
        allowEval,
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
    await this.writeSidecarVersion()
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
    rpc.registerMethod('typora.openFolder', async (params) => {
      const input = asRecord(params)
      const folderPath = expectString(input.folderPath, 'folderPath')
      await editor.openFolder(folderPath)
      return this.getContext()
    })
    rpc.registerMethod('typora.setSourceMode', async (params) => {
      const input = asRecord(params)
      if (typeof input.enabled !== 'boolean') {
        throw new JsonRpcRemoteError(-32602, 'Invalid enabled')
      }
      const sourceMode = await editor.setSourceMode(input.enabled)
      return { sourceMode }
    })
    rpc.registerMethod('typora.eval', async (params) => {
      const input = asRecord(params)
      const code = expectString(input.code, 'code')
      const asyncMode = input.async === true
      const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0
        ? input.timeoutMs
        : 10_000

      // Use Node's vm module rather than the Function constructor: it runs in
      // the current realm (so the code still sees `window`, `document`,
      // `editor` globals etc), but it's an explicit, documented evaluation API
      // with a built-in timeout. IIFE wrapping lets the caller declare locals
      // and `await` when async=true.
      //
      // ⚠ This is a full RCE surface when allowEval=true. The sidecar is the
      // authoritative gate (server.ts); this handler assumes the sidecar
      // already enforced allowEval=true before forwarding the method.
      const vm = window.reqnode!('vm') as typeof import('node:vm')
      const script = asyncMode
        ? `(async () => { ${code} })()`
        : `(() => { ${code} })()`
      try {
        const raw = await vm.runInThisContext(script, {
          displayErrors: true,
          timeout: timeoutMs,
        })
        return { result: toSerializable(raw), async: asyncMode }
      } catch (err) {
        throw new JsonRpcRemoteError(
          -32000,
          err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        )
      }
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
    rpc.registerMethod('typora.plugins.list', async () => {
      return this.listPlugins()
    })
    rpc.registerMethod('typora.plugins.setEnabled', async (params) => {
      const input = asRecord(params)
      const pluginId = expectString(input.pluginId, 'pluginId')
      if (typeof input.enabled !== 'boolean') {
        throw new JsonRpcRemoteError(-32602, 'Invalid enabled')
      }
      if (input.enabled) {
        await getApp().plugins.enablePlugin(pluginId)
      } else {
        getApp().plugins.disablePlugin(pluginId)
      }
      return {
        pluginId,
        enabled: getApp().plugins.isLoaded(pluginId),
      }
    })
    rpc.registerMethod('typora.plugins.commands.list', async (params) => {
      const input = asRecord(params)
      const pluginId = typeof input.pluginId === 'string' ? input.pluginId : null
      return getApp().commands.list().filter(command => !pluginId || command.pluginId === pluginId)
    })
    rpc.registerMethod('typora.plugins.commands.invoke', async (params) => {
      const input = asRecord(params)
      const pluginId = expectString(input.pluginId, 'pluginId')
      const commandId = expectString(input.commandId, 'commandId')
      const command = getApp().commands.list().find(item => item.id === commandId)
      if (!command) {
        throw new JsonRpcRemoteError(404, `Unknown commandId: ${commandId}`)
      }
      if (command.pluginId !== pluginId) {
        throw new JsonRpcRemoteError(409, `Command ${commandId} does not belong to plugin ${pluginId}`)
      }
      const result = await getApp().commands.execute(commandId)
      return {
        pluginId,
        commandId,
        result: result ?? null,
      }
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

  private getSidecarVersionFile(): string {
    return platform.path.join(platform.dataDir, 'remote-control', 'sidecar.version')
  }

  /**
   * If a sidecar from a previous plugin version is still bound to the port,
   * authenticate with the current token and ask it to shut down via
   * `system.shutdown`. Best-effort: if the old token is different (e.g. user
   * rotated) we simply give up — the new ensureSidecar() will surface an
   * EADDRINUSE and the parent-pid watchdog on restart will clean up eventually.
   */
  private async retireStaleSidecarIfAny(): Promise<void> {
    const versionFile = this.getSidecarVersionFile()
    const installed = this.manifest.version
    let recorded: string | null = null
    try {
      recorded = (await platform.fs.readText(versionFile)).trim()
    } catch {
      // No version file → first run under versioning, or fresh data dir.
    }
    if (recorded === installed) return

    // Either never recorded or version changed. If a sidecar is responsive on
    // our port, tell it to shut down; otherwise just fall through.
    const alive = await this.pingSidecar()
    if (!alive) {
      await this.writeSidecarVersion()
      return
    }

    try {
      const socket = new WebSocket(this.getWsUrl())
      const rpc = new JsonRpcPeer(payload => socket.send(payload))
      socket.addEventListener('message', e => rpc.handleMessage(String(e.data)))
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true })
        socket.addEventListener('error', () => reject(new Error('stale sidecar: socket open failed')), { once: true })
      })
      await rpc.request('session.authenticate', {
        token: this.settings.get('token'),
        role: 'client',
      })
      try {
        await rpc.request('system.shutdown')
      } catch {
        // Some sidecars return after queueing shutdown — the socket closes
        // before the reply lands. That's fine.
      }
      try { socket.close() } catch {}
    } catch (err) {
      console.warn('[tpl:remote-control] could not retire stale sidecar:', err)
      return
    }

    // Poll until the port frees (max 3s in 100ms slices).
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (!(await this.pingSidecar())) return
    }
  }

  /** Record the current plugin version as the on-disk sidecar version. */
  private async writeSidecarVersion(): Promise<void> {
    const file = this.getSidecarVersionFile()
    try {
      await platform.fs.mkdir(platform.path.dirname(file))
      await platform.fs.writeText(file, this.manifest.version)
    } catch (err) {
      console.warn('[tpl:remote-control] failed to write sidecar.version:', err)
    }
  }

  private resolveParentPid(): number {
    const processRef = (window as any).process as NodeJS.Process | undefined
    // In Electron renderers, `ppid` is the main (host-app) process PID — the
    // correct lifetime anchor for the sidecar. Fall back to the renderer's own
    // pid, then 0 (which the watcher treats as "skip").
    const ppid = Number(processRef?.ppid ?? 0)
    if (Number.isFinite(ppid) && ppid > 1) return ppid
    const pid = Number(processRef?.pid ?? 0)
    if (Number.isFinite(pid) && pid > 1) return pid
    return 0
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
      mountFolder: editor.getMountFolder(),
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

  private listPlugins() {
    return getApp().plugins.getManifests().map(manifest => ({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? '',
      loading: manifest.loading,
      loaded: getApp().plugins.isLoaded(manifest.id),
    }))
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

/**
 * Best-effort conversion of an arbitrary value to a JSON-RPC-serialisable
 * shape. Used by typora.eval to return user-evaluated expressions across the
 * WebSocket. DOM elements, functions, circular refs, Symbols etc. are
 * coerced to string or null rather than failing the RPC.
 */
function toSerializable(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  if (t === 'bigint') return String(value)
  if (t === 'function' || t === 'symbol') return `<${t}>`
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    try { return String(value) } catch { return null }
  }
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
