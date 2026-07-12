/**
 * Cross-platform `typora.eval` implementation.
 *
 * The original handler ran the user's code through `window.reqnode('vm')`.
 * That only works on Electron Typora (Windows/Linux): on macOS, Typora is a
 * WKWebView with no Node integration, so `window.reqnode` is `undefined` and
 * every eval threw `window.reqnode is not a function` before running a line.
 * The flagship "maximally dangerous" method was, in practice, dead on macOS.
 *
 * The evaluation itself doesn't need Node at all — it needs to run a string in
 * the renderer's realm so the code can see `window`, `document`, `editor`, etc.
 * Indirect eval (`(0, eval)(...)`) does exactly that, in every browser realm.
 * `vm.runInThisContext` is only *preferable* on Electron because it adds a
 * synchronous timeout. So: use vm where it exists, indirect eval where it
 * doesn't, and enforce the timeout ourselves for the async path either way.
 *
 * Timeout semantics, made explicit because they differ by platform:
 *
 *   - **async code** (`async: true`) — the IIFE returns a promise immediately,
 *     so vm's own timeout never covers the awaited work. We race the promise
 *     against a wall-clock timer on *both* platforms. This always works.
 *
 *   - **sync code on Electron** — vm's `timeout` interrupts a runaway loop.
 *
 *   - **sync code on macOS** — nothing can interrupt a synchronous loop on a
 *     single JS thread without vm or a worker. `timeoutMs` is therefore not
 *     enforceable for sync macOS eval; a `while(true)` will hang the renderer.
 *     This is an inherent platform limitation, called out here rather than
 *     papered over. Callers who might send unbounded code should pass
 *     `async: true` and yield.
 */

export const DEFAULT_EVAL_TIMEOUT_MS = 10_000

/** Runs a fully-formed script string in the renderer realm, returns its value. */
export type ScriptRunner = (script: string, timeoutMs: number) => unknown

export interface EvaluatorDeps {
  run: ScriptRunner
  /** Injectable for tests; defaults to window.setTimeout. */
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface EvalParams {
  code: string
  async?: boolean
  timeoutMs?: number
}

export interface EvalResult {
  result: unknown
  async: boolean
}

function normalizeTimeout(value: unknown): number {
  return typeof value === 'number' && value > 0 ? value : DEFAULT_EVAL_TIMEOUT_MS
}

/** Reject if `promise` hasn't settled within `timeoutMs`. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, deps: EvaluatorDeps): Promise<T> {
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const handle = setTimer(() => {
      if (settled) return
      settled = true
      reject(new Error(`eval timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      value => {
        if (settled) return
        settled = true
        clearTimer(handle)
        resolve(value)
      },
      err => {
        if (settled) return
        settled = true
        clearTimer(handle)
        reject(err)
      },
    )
  })
}

/**
 * Evaluate user code in the renderer. The IIFE wrapper lets the caller declare
 * locals and (in async mode) use `await`.
 *
 * Throws a plain Error on failure or timeout; the RPC layer wraps it into a
 * JSON-RPC error. The returned value is passed through `toSerializable` so DOM
 * nodes, functions, and circular structures cross the socket as strings/null
 * instead of failing the whole call.
 */
export async function evaluateInRenderer(params: EvalParams, deps: EvaluatorDeps): Promise<EvalResult> {
  const asyncMode = params.async === true
  const timeoutMs = normalizeTimeout(params.timeoutMs)
  const script = asyncMode
    ? `(async () => { ${params.code} })()`
    : `(() => { ${params.code} })()`

  const raw = deps.run(script, timeoutMs)

  if (!asyncMode) {
    return { result: toSerializable(raw), async: false }
  }

  const awaited = await withTimeout(Promise.resolve(raw as Promise<unknown>), timeoutMs, deps)
  return { result: toSerializable(awaited), async: true }
}

/**
 * Build the platform-appropriate script runner.
 *
 * `reqnode` is `window.reqnode` — a function on Electron, undefined on macOS.
 * Passing it in (rather than reading the global here) keeps this unit-testable.
 */
export function createScriptRunner(reqnode: ((mod: string) => unknown) | undefined): ScriptRunner {
  if (typeof reqnode === 'function') {
    try {
      const vm = reqnode('vm') as { runInThisContext?: (s: string, o: unknown) => unknown } | undefined
      if (vm && typeof vm.runInThisContext === 'function') {
        return (script, timeoutMs) =>
          vm.runInThisContext!(script, { displayErrors: true, timeout: timeoutMs })
      }
    } catch {
      // Fall through to indirect eval.
    }
  }
  // WKWebView (macOS) and any realm without Node: indirect eval runs in global
  // scope, so the script still sees window/document/editor. No sync timeout.
  return (script) => (0, eval)(script)
}

/**
 * Best-effort conversion of an arbitrary value to a JSON-RPC-serialisable
 * shape. DOM elements, functions, circular refs, Symbols etc. are coerced to
 * a string tag or null rather than throwing.
 */
export function toSerializable(value: unknown): unknown {
  if (value === undefined || value === null) return null
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
