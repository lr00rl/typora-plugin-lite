/**
 * Progressive fence warmer.
 *
 * Typora eagerly initializes only the first 8 code blocks and lazily wakes the
 * rest on a zero-margin IntersectionObserver (see typora-fences.ts). We want
 * every block already painted by the time the user's eye reaches it.
 *
 * The obvious fix — `fences.refreshEditor(true)` — force-initializes the whole
 * document in one synchronous pass. On a doc with a few hundred blocks that is
 * a multi-second freeze, which trades a small annoyance for a big one.
 *
 * So: initialize fences ourselves, **top to bottom**, a few per idle slice.
 *
 * Document order is the important part, and it is what makes this safe rather
 * than merely fast. Turning an inert fence into a CodeMirror changes its
 * height. If that happens to a block *above* the viewport, everything below it
 * shifts and the user's scroll position jumps under their thumb. Warming
 * strictly top-to-bottom means that by the time the reader has scrolled past a
 * block, it was warmed long ago — every height change we cause lands *below*
 * the viewport, where it is invisible. Warming in viewport-first or random
 * order would produce exactly the scroll-jump bug we are trying to avoid.
 */

export interface WarmerHost {
  /** All fence elements, in document order. */
  collect(): Element[]
  /** Initialize one fence. Returns true if it did work (i.e. wasn't already live). */
  warm(fence: Element): boolean
  /** Called after each slice, with the fences touched in that slice. */
  onWarmed?(fences: Element[]): void
  /** True once CodeMirror's language modes are available. */
  ready(): boolean
}

export interface WarmerOptions {
  /**
   * Fences to initialize per idle slice. Small enough that a slice fits in a
   * frame budget on a slow machine, large enough that a 500-block document
   * finishes in well under a second of idle time.
   */
  chunkSize?: number
  /**
   * Give up warming documents larger than this. Past a few thousand blocks the
   * document is pathological and eagerly building that many CodeMirror
   * instances would cost more memory than the flicker costs attention; the
   * viewport observer still covers those.
   */
  maxFences?: number
  schedule?: (cb: () => void) => number
  cancel?: (handle: number) => void
}

const DEFAULT_CHUNK = 8
const DEFAULT_MAX_FENCES = 2000

/** requestIdleCallback where available, rAF otherwise (older WKWebView). */
function defaultSchedule(cb: () => void): number {
  const ric = (window as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout: number }) => number)
    | undefined
  if (ric) return ric(cb, { timeout: 250 })
  return requestAnimationFrame(() => cb())
}

function defaultCancel(handle: number): void {
  const cic = (window as any).cancelIdleCallback as ((h: number) => void) | undefined
  if (cic) cic(handle)
  else cancelAnimationFrame(handle)
}

export class FenceWarmer {
  private host: WarmerHost
  private chunkSize: number
  private maxFences: number
  private schedule: (cb: () => void) => number
  private cancel: (handle: number) => void

  /**
   * Bumped on every restart. A slice that finds its generation stale (because
   * the user switched files mid-warm) drops on the floor instead of touching
   * fences that belong to a document that is no longer on screen.
   */
  private generation = 0
  private handle: number | null = null

  constructor(host: WarmerHost, options: WarmerOptions = {}) {
    this.host = host
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK
    this.maxFences = options.maxFences ?? DEFAULT_MAX_FENCES
    this.schedule = options.schedule ?? defaultSchedule
    this.cancel = options.cancel ?? defaultCancel
  }

  /**
   * Abandon the in-flight pass and start a new one over the current document.
   *
   * Even the first slice is scheduled rather than run inline: restart() is
   * called from a MutationObserver callback, and warming a chunk of fences
   * there would land the cost squarely inside the edit that triggered it.
   */
  restart(): void {
    this.stop()
    const generation = ++this.generation
    const fences = this.host.collect()
    if (fences.length === 0 || fences.length > this.maxFences) return
    this.handle = this.schedule(() => this.pump(generation, fences, 0))
  }

  stop(): void {
    this.generation++
    if (this.handle !== null) {
      this.cancel(this.handle)
      this.handle = null
    }
  }

  private pump(generation: number, fences: Element[], index: number): void {
    this.handle = null
    if (generation !== this.generation) return

    // Modes not loaded yet — CodeMirror would come up without a language and
    // render uncoloured. Wait it out; Typora resolves this within a tick or two
    // of startup, and re-checking is far cheaper than warming twice.
    if (!this.host.ready()) {
      this.handle = this.schedule(() => this.pump(generation, fences, index))
      return
    }

    const touched: Element[] = []
    let i = index
    let budget = this.chunkSize
    while (i < fences.length && budget > 0) {
      const fence = fences[i++]!
      // Fences that scrolled into view already got warmed by the observer, and
      // ones the user deleted are detached. Neither costs us a slot.
      if (!fence.isConnected) continue
      if (this.host.warm(fence)) budget--
      touched.push(fence)
    }

    if (touched.length > 0) this.host.onWarmed?.(touched)

    if (i < fences.length) {
      this.handle = this.schedule(() => this.pump(generation, fences, i))
    }
  }
}
