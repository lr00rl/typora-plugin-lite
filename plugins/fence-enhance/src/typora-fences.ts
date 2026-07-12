/**
 * Typed access to Typora's internal fence (code block) controller.
 *
 * Typora renders every fenced code block with CodeMirror, but it does NOT
 * create those CodeMirror instances up front. From Typora's own bundle
 * (`appsrc/main.js`, `Fences.refreshEditor`):
 *
 *     var budget = window.IntersectionObserver ? 8 : 30, used = 0
 *     allFences.forEach(function (el) {
 *       var cid = el.getAttribute('cid')
 *       if (queue[cid])                                  used++
 *       else if (force || (!File.inBusyMode && used < budget))
 *                                  { addCodeBlock(cid);  used++ }
 *       else if (window.IntersectionObserver)
 *                                    intersectionObserve(el)
 *     })
 *
 * So only the first **8** fences are initialized eagerly. Every other fence is
 * handed to an IntersectionObserver with a *zero* rootMargin and stays inert —
 * a plain text node with no syntax colours and no line-number gutter — until
 * its top edge literally touches the viewport. That is the "the page is never
 * ready" flicker: you scroll, and only then does the block light up.
 *
 * Two internals let us fix that:
 *
 *   - `fences.queue[cid]`      → the live CodeMirror instance, or undefined if
 *                                the fence has not been initialized yet. This is
 *                                the same guard Typora uses, so testing it before
 *                                calling `addCodeBlock` is safe and idempotent.
 *   - `fences.addCodeBlock(cid)` → initialize one fence on demand.
 *
 * We never call `refreshEditor(true)`: it force-initializes every fence in one
 * synchronous pass, which janks hard on a long document. We drive
 * `addCodeBlock` ourselves, chunked across idle callbacks, instead.
 */

export interface TyporaCodeMirror {
  lineCount(): number
  refresh?(): void
}

export interface TyporaFencesApi {
  /** cid → CodeMirror instance, for fences that have been initialized. */
  queue: Record<string, TyporaCodeMirror | undefined>
  /** Initialize the fence with this cid. No-op-unsafe: guard with `queue` first. */
  addCodeBlock(cid: string): unknown
  /** True once `lib/codemirror/mode.min.js` has loaded and language modes resolve. */
  modeLoaded?: boolean
}

/** Typora marks fence elements with `mdtype="fences"`; `.md-fences` is the class. */
export const FENCE_SELECTOR = '[mdtype="fences"]'

export function getFencesApi(): TyporaFencesApi | null {
  const fences = (window as any).File?.editor?.fences
  if (!fences || typeof fences.addCodeBlock !== 'function' || !fences.queue) return null
  return fences as TyporaFencesApi
}

/** True once Typora has loaded CodeMirror's language modes. */
export function isModeLoaded(): boolean {
  return getFencesApi()?.modeLoaded === true
}

/**
 * The CodeMirror instance backing this fence, or null if Typora hasn't
 * initialized it yet.
 */
export function getFenceCm(fence: Element): TyporaCodeMirror | null {
  const cid = fence.getAttribute('cid')
  if (!cid) return null
  return getFencesApi()?.queue[cid] ?? null
}

/**
 * Ask Typora to initialize this fence now.
 *
 * Returns true if we actually initialized it, false if it was already live or
 * the call failed. Guarding on `queue[cid]` mirrors Typora's own check in
 * `getCm()`, so this stays idempotent — double-initializing a fence would leak
 * the first CodeMirror instance.
 */
export function initFence(fence: Element): boolean {
  const api = getFencesApi()
  if (!api) return false
  const cid = fence.getAttribute('cid')
  if (!cid || api.queue[cid]) return false
  try {
    api.addCodeBlock(cid)
    return true
  } catch (err) {
    console.warn('[tpl:fence-enhance] addCodeBlock failed for cid', cid, err)
    return false
  }
}
