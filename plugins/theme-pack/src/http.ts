export interface HttpGetResult {
  status: number
  body: string
  etag: string | null
}

export interface HttpDownloadResult {
  status: number
  etag: string | null
}

export interface HttpClient {
  getText(url: string, etag?: string | null): Promise<HttpGetResult>
  download(url: string, destPath: string, etag?: string | null): Promise<HttpDownloadResult>
}

export function parseEtag(headers: string): string | null {
  const match = headers.match(/^etag:\s*(.+)$/im)
  if (!match?.[1]) return null
  return match[1].trim()
}

type ShellLike = {
  run(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<string>
  escape(text: string): string
}

type FsLike = {
  mkdir(path: string): Promise<void>
  readText(path: string): Promise<string>
  copy(src: string, dest: string): Promise<void>
  remove(path: string): Promise<void>
}

type NodeIncoming = {
  statusCode?: number
  headers: { location?: string; etag?: string | string[] }
  on(event: string, listener: (...args: unknown[]) => void): unknown
  resume?: () => void
}

type NodeHttpsLike = {
  get(
    url: string,
    options: { headers?: Record<string, string> },
    callback: (res: NodeIncoming) => void,
  ): {
    on(event: string, listener: (...args: unknown[]) => void): unknown
    destroy(): void
    setTimeout?: (ms: number, callback: () => void) => void
  }
}

type NodeFsLike = {
  mkdirSync(path: string, opts?: { recursive?: boolean }): unknown
  writeFileSync(path: string, data: Buffer | string): unknown
}

const USER_AGENT = 'typora-plugin-lite-theme-pack'
const HTTP_TIMEOUT_MS = 20_000

export function createHttpClient(opts: {
  preferNode: boolean
  reqnode?: ((name: string) => unknown) | undefined
  shell: ShellLike
  fs: FsLike
  tmpDir: string
  cwd: string
}): HttpClient {
  if (opts.preferNode) {
    const https = opts.reqnode?.('https') as NodeHttpsLike | undefined
    const nfs = opts.reqnode?.('fs') as NodeFsLike | undefined
    if (typeof https?.get === 'function' && typeof nfs?.writeFileSync === 'function' && typeof nfs?.mkdirSync === 'function') {
      return new NodeHttpClient(https, nfs)
    }
    throw new Error('theme-pack: Electron Node https is required on Windows/Linux')
  }
  return new CurlHttpClient(opts.shell, opts.fs, opts.tmpDir, opts.cwd)
}

export class NodeHttpClient implements HttpClient {
  constructor(
    private readonly https: NodeHttpsLike,
    private readonly fs: NodeFsLike,
  ) {}

  async getText(url: string, etag?: string | null): Promise<HttpGetResult> {
    const result = await this.request(url, etag)
    return {
      status: result.status,
      body: result.status === 304 ? '' : result.body.toString('utf8'),
      etag: result.etag,
    }
  }

  async download(url: string, destPath: string, etag?: string | null): Promise<HttpDownloadResult> {
    const result = await this.request(url, etag)
    if (result.status === 200) {
      this.fs.mkdirSync(parentDir(destPath), { recursive: true })
      this.fs.writeFileSync(destPath, result.body)
    }
    return { status: result.status, etag: result.etag }
  }

  private request(url: string, etag?: string | null, redirects = 0): Promise<{
    status: number
    body: Buffer
    etag: string | null
  }> {
    if (redirects > 5) {
      return Promise.reject(new Error('theme-pack: too many HTTP redirects'))
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return Promise.reject(new Error(`theme-pack: invalid URL ${url}`))
    }
    if (parsed.protocol !== 'https:') {
      return Promise.reject(new Error('theme-pack: only https is allowed'))
    }

    return new Promise((resolve, reject) => {
      const req = this.https.get(url, {
        headers: {
          'User-Agent': USER_AGENT,
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
      }, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume?.()
          const next = new URL(res.headers.location, url).toString()
          resolve(this.request(next, etag, redirects + 1))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk: unknown) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        })
        res.on('end', () => {
          const raw = res.headers.etag
          resolve({
            status,
            body: Buffer.concat(chunks),
            etag: Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null),
          })
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout?.(HTTP_TIMEOUT_MS, () => {
        req.destroy()
        reject(new Error('theme-pack: HTTP timeout'))
      })
    })
  }
}

export class CurlHttpClient implements HttpClient {
  constructor(
    private readonly shell: ShellLike,
    private readonly fs: FsLike,
    private readonly tmpDir: string,
    private readonly cwd: string,
  ) {}

  async getText(url: string, etag?: string | null): Promise<HttpGetResult> {
    const id = uniqueId()
    const bodyPath = `${this.tmpDir}/get-${id}.body`
    const headerPath = `${this.tmpDir}/get-${id}.hdr`
    try {
      const status = await this.curl(url, bodyPath, headerPath, etag)
      const headers = await this.readOptional(headerPath)
      const body = status === 304 ? '' : await this.readOptional(bodyPath)
      return { status, body, etag: parseEtag(headers) }
    } finally {
      await this.cleanup(bodyPath, headerPath)
    }
  }

  async download(url: string, destPath: string, etag?: string | null): Promise<HttpDownloadResult> {
    const id = uniqueId()
    const bodyPath = `${this.tmpDir}/dl-${id}.body`
    const headerPath = `${this.tmpDir}/dl-${id}.hdr`
    try {
      const status = await this.curl(url, bodyPath, headerPath, etag)
      const headers = await this.readOptional(headerPath)
      if (status === 200) {
        await this.fs.mkdir(parentDir(destPath))
        await this.fs.copy(bodyPath, destPath)
      }
      return { status, etag: parseEtag(headers) }
    } finally {
      await this.cleanup(bodyPath, headerPath)
    }
  }

  private async curl(
    url: string,
    bodyPath: string,
    headerPath: string,
    etag?: string | null,
  ): Promise<number> {
    await this.fs.mkdir(this.tmpDir)
    const extra = etag
      ? ` -H ${this.shell.escape(`If-None-Match: ${etag}`)}`
      : ''
    const cmd = [
      'curl -sS -L --max-time 20',
      `-A '${USER_AGENT}'`,
      `-D ${this.shell.escape(headerPath)}`,
      `-o ${this.shell.escape(bodyPath)}`,
      extra,
      `-w '%{http_code}'`,
      this.shell.escape(url),
    ].join(' ')
    const raw = (await this.shell.run(cmd, { cwd: this.cwd, timeout: 25_000 })).trim()
    const status = Number.parseInt(raw.slice(-3), 10)
    if (!Number.isInteger(status)) {
      throw new Error(`theme-pack: curl returned no HTTP status (${raw})`)
    }
    return status
  }

  private async readOptional(path: string): Promise<string> {
    try {
      return await this.fs.readText(path)
    } catch {
      return ''
    }
  }

  private async cleanup(...paths: string[]): Promise<void> {
    for (const path of paths) {
      try { await this.fs.remove(path) } catch {}
    }
  }
}

function uniqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index < 0) return '.'
  return normalized.slice(0, index) || '.'
}
