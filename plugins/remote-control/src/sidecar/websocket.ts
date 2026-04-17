import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

export interface WebSocketServerConnection {
  readonly id: string
  readonly request: IncomingMessage
  sendText(payload: string): void
  close(code?: number, reason?: string): void
  onMessage(listener: (payload: string) => void): void
  onClose(listener: () => void): void
}

export interface AcceptWebSocketOptions {
  request: IncomingMessage
  socket: Duplex
  head: Buffer
}

function writeHttpError(socket: Duplex, statusCode: number, reason: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const parts: Buffer[] = []
  const firstByte = 0x80 | (opcode & 0x0f)
  parts.push(Buffer.from([firstByte]))

  if (payload.length < 126) {
    parts.push(Buffer.from([payload.length]))
  } else if (payload.length <= 0xffff) {
    const header = Buffer.alloc(3)
    header[0] = 126
    header.writeUInt16BE(payload.length, 1)
    parts.push(header)
  } else {
    const header = Buffer.alloc(9)
    header[0] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 1)
    parts.push(header)
  }

  parts.push(payload)
  return Buffer.concat(parts)
}

class Connection implements WebSocketServerConnection {
  readonly id = randomUUID()
  private readonly messageListeners = new Set<(payload: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private buffer = Buffer.alloc(0)
  private closed = false

  constructor(
    readonly request: IncomingMessage,
    private readonly socket: Duplex,
  ) {
    socket.on('data', chunk => {
      this.handleChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    socket.on('close', () => {
      this.finishClose()
    })
    socket.on('error', () => {
      this.finishClose()
    })
  }

  pushHead(head: Buffer): void {
    if (head.length > 0) {
      this.handleChunk(head)
    }
  }

  sendText(payload: string): void {
    if (this.closed) return
    this.socket.write(encodeFrame(0x1, Buffer.from(payload)))
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    const reasonBuffer = Buffer.from(reason)
    const payload = Buffer.alloc(2 + reasonBuffer.length)
    payload.writeUInt16BE(code, 0)
    reasonBuffer.copy(payload, 2)
    this.socket.write(encodeFrame(0x8, payload))
    this.socket.end()
    this.finishClose()
  }

  onMessage(listener: (payload: string) => void): void {
    this.messageListeners.add(listener)
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener)
  }

  private finishClose(): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) {
      listener()
    }
    this.closeListeners.clear()
    this.messageListeners.clear()
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])

    while (true) {
      if (this.buffer.length < 2) return

      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let payloadLength = second & 0x7f
      let offset = 2

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return
        payloadLength = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return
        const value = Number(this.buffer.readBigUInt64BE(2))
        if (!Number.isSafeInteger(value)) {
          this.close(1009, 'Frame too large')
          return
        }
        payloadLength = value
        offset = 10
      }

      const maskBytes = masked ? 4 : 0
      const frameLength = offset + maskBytes + payloadLength
      if (this.buffer.length < frameLength) return

      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null
      const payloadStart = offset + maskBytes
      const payload = Buffer.from(this.buffer.subarray(payloadStart, payloadStart + payloadLength))
      this.buffer = this.buffer.subarray(frameLength)

      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4]!
        }
      }

      if (!fin) {
        this.close(1003, 'Fragmented frames are not supported')
        return
      }

      if (opcode === 0x8) {
        this.socket.end()
        this.finishClose()
        return
      }

      if (opcode === 0x9) {
        this.socket.write(encodeFrame(0xA, payload))
        continue
      }

      if (opcode !== 0x1) {
        this.close(1003, 'Only text frames are supported')
        return
      }

      const text = payload.toString('utf8')
      for (const listener of this.messageListeners) {
        listener(text)
      }
    }
  }
}

export function acceptWebSocket(options: AcceptWebSocketOptions): WebSocketServerConnection | null {
  const { request, socket, head } = options
  const keyHeader = request.headers['sec-websocket-key']

  if (request.url !== '/rpc') {
    writeHttpError(socket, 404, 'Not Found')
    return null
  }

  if (typeof keyHeader !== 'string' || !keyHeader) {
    writeHttpError(socket, 400, 'Bad Request')
    return null
  }

  const acceptKey = createHash('sha1')
    .update(`${keyHeader}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')

  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n',
  ].join('\r\n')

  socket.write(response)

  const connection = new Connection(request, socket)
  connection.pushHead(head)
  return connection
}
