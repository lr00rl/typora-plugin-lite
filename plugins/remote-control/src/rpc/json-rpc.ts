export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string | null
  method: string
  params?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number | string | null
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: number | string | null
  error: JsonRpcErrorShape
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcErrorShape {
  code: number
  message: string
  data?: unknown
}

export class JsonRpcRemoteError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }

  toJSON(): JsonRpcErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.data === undefined ? {} : { data: this.data }),
    }
  }
}

type MethodHandler = (params: unknown, request: JsonRpcRequest) => unknown | Promise<unknown>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export interface RequestOptions {
  /**
   * Reject the request if no response arrives within this many milliseconds.
   * Omit (or pass 0) for no timeout — the historical behaviour, where a pending
   * request only ever settles on a reply or a socket close.
   *
   * A timeout matters because `failPending` fires only when the *socket* drops.
   * A peer that stays connected but silently never answers (a wedged renderer,
   * a handler that forgot to return) would otherwise leave the caller awaiting
   * forever.
   */
  timeoutMs?: number
}

export class JsonRpcPeer {
  private readonly methods = new Map<string, MethodHandler>()
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
    timer?: ReturnType<typeof setTimeout>
  }>()
  private nextId = 1

  constructor(private readonly sendRaw: (payload: string) => void) {}

  registerMethod(method: string, handler: MethodHandler): void {
    this.methods.set(method, handler)
  }

  unregisterMethod(method: string): void {
    this.methods.delete(method)
  }

  notify(method: string, params?: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })
  }

  async request<T>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    const id = this.nextId++
    const response = new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs
      const timer = timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            // Only reject if still pending — a reply that lands in the same tick
            // clears the entry first.
            if (!this.pending.has(id)) return
            this.pending.delete(id)
            reject(new JsonRpcRemoteError(-32001, `Request timed out after ${timeoutMs}ms: ${method}`))
          }, timeoutMs)
        : undefined
      timer?.unref?.()
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      })
    })

    this.send({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })

    return await response
  }

  failPending(error: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
  }

  handleMessage(raw: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(raw) as JsonRpcMessage
    } catch {
      return
    }

    if (!isObject(message) || message.jsonrpc !== '2.0') return

    if (typeof message.method === 'string') {
      if ('id' in message) {
        void this.handleRequest(message as JsonRpcRequest)
      }
      return
    }

    if (!('id' in message)) return

    const pending = this.pending.get(Number(message.id))
    if (!pending) return
    this.pending.delete(Number(message.id))
    if (pending.timer) clearTimeout(pending.timer)

    if ('error' in message && isObject(message.error)) {
      const failure = message as JsonRpcFailure
      pending.reject(new JsonRpcRemoteError(
        failure.error.code,
        failure.error.message,
        failure.error.data,
      ))
      return
    }

    pending.resolve((message as JsonRpcSuccess).result)
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.methods.get(request.method)
    if (!handler) {
      this.send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      })
      return
    }

    try {
      const result = await handler(request.params, request)
      this.send({
        jsonrpc: '2.0',
        id: request.id,
        result,
      })
    } catch (error) {
      const rpcError = error instanceof JsonRpcRemoteError
        ? error
        : new JsonRpcRemoteError(-32000, error instanceof Error ? error.message : String(error))
      this.send({
        jsonrpc: '2.0',
        id: request.id,
        error: rpcError.toJSON(),
      })
    }
  }

  private send(message: JsonRpcSuccess | JsonRpcFailure | JsonRpcRequest | JsonRpcNotification): void {
    this.sendRaw(JSON.stringify(message))
  }
}
