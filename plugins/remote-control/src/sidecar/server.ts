import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import { JsonRpcPeer, JsonRpcRemoteError } from '../rpc/json-rpc.js'
import { acceptWebSocket, type WebSocketServerConnection } from './websocket.js'

type SessionRole = 'client' | 'typora'

interface Session {
  id: string
  connection: WebSocketServerConnection
  peer: JsonRpcPeer
  authenticated: boolean
  role: SessionRole | null
}

interface RunningExec {
  execId: string
  ownerSessionId: string
  command: string
  cwd?: string
  child: ChildProcessByStdio<null, Readable, Readable>
  startedAt: number
}

export interface SidecarServerOptions {
  host: string
  port: number
  token: string
}

export interface SidecarServer {
  readonly host: string
  readonly port: number
  close(): Promise<void>
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  return value as Record<string, unknown>
}

function requireAuth(session: Session): void {
  if (!session.authenticated) {
    throw new JsonRpcRemoteError(401, 'Unauthenticated session')
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new JsonRpcRemoteError(-32602, `Invalid ${field}`)
  }
  return value
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function runBufferedCommand(params: unknown): Promise<{
  command: string
  cwd?: string
  exitCode: number
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}> {
  const input = asObject(params)
  const command = asString(input.command, 'command')
  const cwd = asOptionalString(input.cwd)
  const timeoutMs = asOptionalNumber(input.timeoutMs) ?? 30_000
  const maxBytes = asOptionalNumber(input.maxBytes) ?? 262_144

  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let finished = false

    const timer = setTimeout(() => {
      child.kill()
    }, timeoutMs)

    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      if (target === 'stdout') {
        const next = stdout + chunk
        stdout = next.slice(0, maxBytes)
        stdoutTruncated = stdoutTruncated || next.length > maxBytes
        return
      }

      const next = stderr + chunk
      stderr = next.slice(0, maxBytes)
      stderrTruncated = stderrTruncated || next.length > maxBytes
    }

    child.stdout.on('data', chunk => {
      append('stdout', chunk.toString())
    })
    child.stderr.on('data', chunk => {
      append('stderr', chunk.toString())
    })
    child.on('error', error => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exitCode, signal) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({
        command,
        ...(cwd ? { cwd } : {}),
        exitCode: exitCode ?? -1,
        signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
      })
    })
  })
}

export async function createSidecarServer(options: SidecarServerOptions): Promise<SidecarServer> {
  const server = createServer()
  const sessions = new Map<string, Session>()
  const processes = new Map<string, RunningExec>()
  let typoraSessionId: string | null = null

  const cleanupSessionProcesses = (sessionId: string) => {
    for (const running of [...processes.values()]) {
      if (running.ownerSessionId !== sessionId) continue
      running.child.kill()
      processes.delete(running.execId)
    }
  }

  const closeServer = async () => {
    for (const running of processes.values()) {
      running.child.kill()
    }
    processes.clear()

    for (const session of sessions.values()) {
      session.connection.close(1001, 'Server shutting down')
    }
    sessions.clear()

    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  server.on('upgrade', (request, socket, head) => {
    const connection = acceptWebSocket({ request, socket, head })
    if (!connection) return

    const peer = new JsonRpcPeer(payload => {
      connection.sendText(payload)
    })
    const session: Session = {
      id: connection.id,
      connection,
      peer,
      authenticated: false,
      role: null,
    }
    sessions.set(session.id, session)

    connection.onClose(() => {
      sessions.delete(session.id)
      if (typoraSessionId === session.id) {
        typoraSessionId = null
      }
      peer.failPending(new Error('WebSocket session closed'))
      cleanupSessionProcesses(session.id)
    })

    connection.onMessage(payload => {
      peer.handleMessage(payload)
    })

    peer.registerMethod('session.authenticate', (params) => {
      const input = asObject(params)
      const token = asString(input.token, 'token')
      const role = (input.role === 'typora' ? 'typora' : 'client') as SessionRole

      if (token !== options.token) {
        throw new JsonRpcRemoteError(403, 'Invalid token')
      }

      session.authenticated = true
      session.role = role
      if (role === 'typora') {
        typoraSessionId = session.id
      }

      return {
        authenticated: true,
        role,
        sessionId: session.id,
      }
    })

    peer.registerMethod('system.ping', () => {
      requireAuth(session)
      return 'pong'
    })

    peer.registerMethod('system.getInfo', () => {
      requireAuth(session)
      return {
        pid: process.pid,
        host: options.host,
        port: (server.address() as AddressInfo).port,
        typoraConnected: !!typoraSessionId,
        sessionCount: sessions.size,
        execCount: processes.size,
      }
    })

    peer.registerMethod('system.shutdown', async () => {
      requireAuth(session)
      queueMicrotask(() => {
        void closeServer()
      })
      return { stopping: true }
    })

    peer.registerMethod('exec.run', async (params) => {
      requireAuth(session)
      return await runBufferedCommand(params)
    })

    peer.registerMethod('exec.start', async (params) => {
      requireAuth(session)
      const input = asObject(params)
      const command = asString(input.command, 'command')
      const cwd = asOptionalString(input.cwd)

      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const execId = `${Date.now()}-${processes.size + 1}`
      const running: RunningExec = {
        execId,
        ownerSessionId: session.id,
        command,
        ...(cwd ? { cwd } : {}),
        child,
        startedAt: Date.now(),
      }
      processes.set(execId, running)

      child.stdout.on('data', chunk => {
        session.peer.notify('exec.stdout', {
          execId,
          data: chunk.toString(),
        })
      })
      child.stderr.on('data', chunk => {
        session.peer.notify('exec.stderr', {
          execId,
          data: chunk.toString(),
        })
      })
      child.on('close', (exitCode, signal) => {
        processes.delete(execId)
        session.peer.notify('exec.exit', {
          execId,
          exitCode: exitCode ?? -1,
          signal,
        })
      })

      return {
        execId,
        pid: child.pid,
        command,
        ...(cwd ? { cwd } : {}),
      }
    })

    peer.registerMethod('exec.kill', (params) => {
      requireAuth(session)
      const input = asObject(params)
      const execId = asString(input.execId, 'execId')
      const signal = asOptionalString(input.signal) ?? 'SIGTERM'
      const running = processes.get(execId)
      if (!running) {
        throw new JsonRpcRemoteError(404, `Unknown execId: ${execId}`)
      }
      return {
        execId,
        killed: running.child.kill(signal as NodeJS.Signals),
      }
    })

    peer.registerMethod('exec.list', () => {
      requireAuth(session)
      return [...processes.values()].map(running => ({
        execId: running.execId,
        ownerSessionId: running.ownerSessionId,
        command: running.command,
        cwd: running.cwd ?? null,
        pid: running.child.pid,
        startedAt: running.startedAt,
      }))
    })

    const forwardTypora = async (method: string, params: unknown) => {
      requireAuth(session)
      if (!typoraSessionId) {
        throw new JsonRpcRemoteError(503, 'Typora session is unavailable')
      }
      const target = sessions.get(typoraSessionId)
      if (!target) {
        typoraSessionId = null
        throw new JsonRpcRemoteError(503, 'Typora session is unavailable')
      }
      return await target.peer.request(method, params)
    }

    for (const method of [
      'typora.getContext',
      'typora.getDocument',
      'typora.setDocument',
      'typora.insertText',
      'typora.openFile',
      'typora.commands.list',
      'typora.commands.invoke',
    ]) {
      peer.registerMethod(method, async (params) => await forwardTypora(method, params))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(options.port, options.host, () => resolve())
    server.once('error', reject)
  })

  const address = server.address() as AddressInfo

  return {
    host: options.host,
    port: address.port,
    close: closeServer,
  }
}

function getArgValue(argv: string[], name: string): string | undefined {
  const index = argv.findIndex(token => token === name)
  if (index === -1) return undefined
  return argv[index + 1]
}

export async function runSidecarCli(argv = process.argv): Promise<void> {
  const host = getArgValue(argv, '--host') ?? '127.0.0.1'
  const port = Number.parseInt(getArgValue(argv, '--port') ?? '5619', 10)
  const token = getArgValue(argv, '--token') ?? ''

  if (!token) {
    throw new Error('Missing required --token')
  }

  await createSidecarServer({
    host,
    port,
    token,
  })
}

const isEntrypoint = typeof process !== 'undefined'
  && typeof import.meta !== 'undefined'
  && import.meta.url === new URL(process.argv[1] ?? '', 'file://').href

if (isEntrypoint) {
  runSidecarCli().catch(error => {
    console.error('[tpl:remote-control:sidecar]', error)
    process.exitCode = 1
  })
}
