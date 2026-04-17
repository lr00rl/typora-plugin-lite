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

export class JsonRpcPeer {
  private readonly methods = new Map<string, MethodHandler>()
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
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

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
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
    for (const { reject } of this.pending.values()) {
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
