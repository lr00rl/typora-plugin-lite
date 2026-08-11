import {
  type FrecencyStore,
  pruneStore,
  recordOpen,
} from './frecency.js'

interface RecorderOptions {
  getStore: () => FrecencyStore
  setStore: (store: FrecencyStore) => void
  save: () => Promise<void>
  now?: () => number
  maxEntries: number
}

/**
 * Serializes confirmed file-open transitions and keeps a failed save as a
 * retryable draft. Every `record` call is a real transition; only
 * `retryPending` may persist an existing transition without incrementing it.
 */
export class ConfirmedOpenRecorder {
  private readonly now: () => number
  private queue = Promise.resolve()
  private pending: { store: FrecencyStore } | null = null

  constructor(private readonly options: RecorderOptions) {
    this.now = options.now ?? Date.now
  }

  record(path: string): Promise<void> {
    const observedAt = this.now()
    const run = this.queue.catch(() => {}).then(() => this.recordSerial(path, observedAt))
    this.queue = run
    return run
  }

  /** Retry a failed draft without creating another open observation. */
  retryPending(): Promise<void> {
    const run = this.queue.catch(() => {}).then(() => this.flushPending())
    this.queue = run
    return run
  }

  private async recordSerial(path: string, observedAt: number): Promise<void> {
    if (!path) return
    const store = pruneStore(
      recordOpen(this.options.getStore(), path, observedAt),
      observedAt,
      this.options.maxEntries,
    )
    // Replace any failed snapshot with the newest cumulative in-memory state.
    // `getStore()` already contains earlier unsaved transitions.
    this.pending = { store }
    this.options.setStore(store)
    await this.flushPending()
  }

  private async flushPending(): Promise<void> {
    const pending = this.pending
    if (!pending) return
    this.options.setStore(pending.store)
    await this.options.save()
    if (this.pending === pending) this.pending = null
  }
}

/** Run recent persistence only after the host confirms that the file opened. */
export async function recordAfterSuccessfulOpen(
  open: () => Promise<void>,
  record: () => Promise<void>,
  observedByHook = false,
  beforeExplicitRecord: () => void = () => {},
): Promise<void> {
  await open()
  if (!observedByHook) {
    beforeExplicitRecord()
    await record()
  }
}

type OpenFileLibrary = {
  openFile: (...args: any[]) => any
}

export interface ConfirmedOpenHook {
  dispose: () => void
  isCurrent: (library?: { openFile: (...args: any[]) => any }) => boolean
}

interface DispatcherState {
  library: OpenFileLibrary
  upstream: OpenFileLibrary['openFile']
  wrapper: OpenFileLibrary['openFile']
  subscribers: Set<(path: string) => void>
}

const DISPATCHER = Symbol('tpl.quick-open.confirmed-open-dispatcher')
type DispatcherFunction = OpenFileLibrary['openFile'] & { [DISPATCHER]?: DispatcherState }

/**
 * Observe Typora library opens when its callback fires or returned Promise
 * resolves. The exact receiver, callback receiver, arguments, and return value
 * are preserved, and the two success signals share one once guard.
 */
export function installConfirmedOpenHook(
  library: OpenFileLibrary,
  onConfirmed: (path: string) => void,
): ConfirmedOpenHook {
  const current = library.openFile as DispatcherFunction
  let state = current[DISPATCHER]
  if (!state || state.library !== library) {
    const upstream = library.openFile
    const subscribers = new Set<(path: string) => void>()
    const wrapped: DispatcherFunction = function (this: unknown, path: string, callback: unknown, ...args: unknown[]) {
      let confirmed = false
      const confirm = (): void => {
        if (confirmed) return
        confirmed = true
        for (const subscriber of [...subscribers]) subscriber(path)
      }
      const confirmedCallback = typeof callback === 'function'
        ? function (this: unknown, ...callbackArgs: unknown[]) {
            try {
              return callback.apply(this, callbackArgs)
            } finally {
              confirm()
            }
          }
        : callback
      const result = upstream.call(this, path, confirmedCallback, ...args)
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).then(confirm, () => {})
      }
      return result
    }
    state = { library, upstream, wrapper: wrapped, subscribers }
    wrapped[DISPATCHER] = state
    library.openFile = wrapped
  }
  state.subscribers.add(onConfirmed)
  let disposed = false
  return {
    isCurrent: (currentLibrary = library) => (
      !disposed
      && currentLibrary === library
      && library.openFile === state.wrapper
      && state.subscribers.has(onConfirmed)
    ),
    dispose: () => {
      if (disposed) return
      disposed = true
      state.subscribers.delete(onConfirmed)
      if (state.subscribers.size === 0 && library.openFile === state.wrapper) {
        try { library.openFile = state.upstream } catch {}
      }
    },
  }
}

/** Best-effort installation for hosts that expose a frozen/read-only method. */
export function tryInstallConfirmedOpenHook(
  library: OpenFileLibrary,
  onConfirmed: (path: string) => void,
  onError: (error: unknown) => void = () => {},
): ConfirmedOpenHook | null {
  try {
    return installConfirmedOpenHook(library, onConfirmed)
  } catch (error) {
    try { onError(error) } catch {}
    return null
  }
}
