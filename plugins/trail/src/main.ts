/**
 * Trail 足迹: bounded back/forward navigation across recently visited notes.
 *
 * Recording is event-driven, not polled: every open path funnels through
 * `library.openFile` (tree clicks, quick open, the related-notes palette, and
 * the remote CLI all pass it), so wrapping that one method captures every
 * switch in exact order. A 500ms poll was tried first and lost intermediate
 * opens under WKWebView timer throttling. A slow reconciler poll only fixes
 * `current` when reality drifted (a silent no-op open, a file closed).
 * `File.onFileOpened` is NOT usable as the event source: Typora never calls
 * it for library.openFile (keeps its own reference).
 *
 * Model: two stacks capped at CAP entries. A user-driven open pushes the
 * previous file onto back and clears forward; back()/forward() move entries
 * between the stacks without re-recording (the `replaying` flag), and every
 * jump verifies the editor actually landed before committing.
 */

import { Plugin, editor } from '@typora-plugin-lite/core'

const CAP = 3
const RECONCILE_MS = 1500

const CSS = `
#tpl-trail {
  position: fixed;
  right: 22px;
  bottom: 20px;
  z-index: 900;
  display: flex;
  gap: 6px;
  user-select: none;
}
#tpl-trail[hidden] { display: none; }
.tpl-trail-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 30px;
  height: 30px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--tpl-ui-border, var(--border-color, rgba(128,128,128,0.18)));
  background: var(--tpl-ui-surface, var(--bg-color, #fff));
  color: var(--tpl-ui-muted, var(--text-color, inherit));
  box-shadow: 0 2px 10px rgba(24, 22, 20, 0.08);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.66;
  transition: opacity 120ms ease-out, background 120ms ease-out;
}
.tpl-trail-btn:hover:not(:disabled) {
  opacity: 1;
  background: var(--tpl-ui-surface-subtle, rgba(128,128,128,0.06));
}
.tpl-trail-btn:disabled {
  cursor: default;
  opacity: 0.28;
  box-shadow: none;
}
.tpl-trail-count {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}
@media (prefers-reduced-motion: reduce) {
  .tpl-trail-btn { transition: none; }
}
`

export default class TrailPlugin extends Plugin {
  private backStack: string[] = []
  private fwdStack: string[] = []
  private current = ''
  private replaying = false
  private restores: Array<() => void> = []
  private rootEl: HTMLDivElement | null = null
  private backBtn: HTMLButtonElement | null = null
  private fwdBtn: HTMLButtonElement | null = null

  onload(): void {
    this.registerCss(CSS)
    this.current = editor.getFilePath() || ''
    this.buildButtons()
    this.hookLibraryOpen()

    this.registerInterval(() => this.reconcile(), RECONCILE_MS)
    this.registerHotkey('Mod+Alt+ArrowLeft', () => void this.back())
    this.registerHotkey('Mod+Alt+ArrowRight', () => void this.forward())
    this.registerCommand({ id: 'trail:back', name: '足迹: 上一篇', callback: () => this.back() })
    this.registerCommand({ id: 'trail:forward', name: '足迹: 下一篇', callback: () => this.forward() })
    this.registerCommand({ id: 'trail:state', name: '足迹: 状态', callback: () => this.state() })
    this.addDisposable(() => {
      for (const restore of this.restores.splice(0)) {
        try { restore() } catch {}
      }
    })
  }

  onunload(): void {
    this.rootEl?.remove()
    this.rootEl = null
    this.backBtn = null
    this.fwdBtn = null
  }

  /**
   * The single choke point for every open path. Records at call time (order
   * is what matters); a silent no-op open is later corrected by reconcile().
   */
  private hookLibraryOpen(): void {
    const library = (window as any).File?.editor?.library
    if (typeof library?.openFile !== 'function') return
    const original = library.openFile
    const plugin = this
    library.openFile = function hooked(this: unknown, path: string, ...rest: unknown[]) {
      try {
        plugin.record(path)
      } catch (err) {
        console.warn('[tpl:trail] record failed', err)
      }
      return original.call(this, path, ...rest)
    }
    this.restores.push(() => { library.openFile = original })
  }

  private record(path: string): void {
    if (!path || !/^(\/|[A-Za-z]:)/.test(path)) return
    const next = path.replace(/\\/g, '/')
    if (next === this.current) return
    if (this.replaying) {
      this.replaying = false
      this.current = next
      return
    }
    if (this.current) {
      this.backStack.push(this.current)
      if (this.backStack.length > CAP) this.backStack.shift()
    }
    this.fwdStack = []
    this.current = next
    this.refreshButtons()
  }

  /** Reality check for opens that never landed; never moves the stacks. */
  private reconcile(): void {
    const actual = (editor.getFilePath() || '').replace(/\\/g, '/')
    if (actual && actual !== this.current) this.current = actual
  }

  private async back(): Promise<boolean> {
    const target = this.backStack.pop()
    if (!target) {
      this.showNotice('已经是最早的一篇')
      this.refreshButtons()
      return false
    }
    return this.jump(target, (origin) => {
      this.fwdStack.push(origin)
      if (this.fwdStack.length > CAP) this.fwdStack.shift()
    }, () => {
      this.backStack.push(target)
    })
  }

  private async forward(): Promise<boolean> {
    const target = this.fwdStack.pop()
    if (!target) {
      this.showNotice('已经是最新的一篇')
      this.refreshButtons()
      return false
    }
    return this.jump(target, (origin) => {
      this.backStack.push(origin)
      if (this.backStack.length > CAP) this.backStack.shift()
    }, () => {
      this.fwdStack.push(target)
    })
  }

  /**
   * Move to a stack target: on success run `commit(origin)` (push the file we
   * came FROM to the other stack), on failure run `revert` (put the target
   * back) so a dead path does not silently swallow history.
   */
  private async jump(target: string, commit: (origin: string) => void, revert: () => void): Promise<boolean> {
    const origin = this.current
    try {
      this.replaying = true
      await editor.openFile(target)
      // openFile can resolve without the editor actually switching (silent
      // no-op); committing anyway would push a phantom entry. Verify the
      // landing before moving the stacks.
      const landed = editor.getFilePath()
      if (!landed || landed.replace(/\\/g, '/') !== target.replace(/\\/g, '/')) {
        throw new Error(`open did not land on ${target}`)
      }
      this.current = target
      commit(origin)
      this.refreshButtons()
      return true
    } catch (err) {
      this.replaying = false
      revert()
      console.warn('[tpl:trail] jump failed', err)
      this.showNotice(`打不开了：${basename(target)}（可能已移动或删除）`)
      this.refreshButtons()
      return false
    }
  }

  private buildButtons(): void {
    const root = document.createElement('div')
    root.id = 'tpl-trail'
    this.backBtn = this.makeButton('‹', '上一篇 (Cmd/Ctrl+Alt+←)', () => void this.back())
    this.fwdBtn = this.makeButton('›', '下一篇 (Cmd/Ctrl+Alt+→)', () => void this.forward())
    root.appendChild(this.backBtn)
    root.appendChild(this.fwdBtn)
    document.body.appendChild(root)
    this.rootEl = root
    this.refreshButtons()
  }

  private makeButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'tpl-trail-btn'
    btn.type = 'button'
    btn.title = title
    btn.setAttribute('aria-label', title)
    const arrow = document.createElement('span')
    arrow.textContent = label
    const count = document.createElement('span')
    count.className = 'tpl-trail-count'
    btn.appendChild(arrow)
    btn.appendChild(count)
    btn.addEventListener('click', evt => {
      evt.preventDefault()
      if (!btn.disabled) onClick()
    })
    return btn
  }

  private refreshButtons(): void {
    if (!this.rootEl || !this.backBtn || !this.fwdBtn) return
    const backN = this.backStack.length
    const fwdN = this.fwdStack.length
    this.rootEl.hidden = backN + fwdN === 0
    this.backBtn.disabled = backN === 0
    this.fwdBtn.disabled = fwdN === 0
    const backCount = this.backBtn.querySelector('.tpl-trail-count')
    const fwdCount = this.fwdBtn.querySelector('.tpl-trail-count')
    if (backCount) backCount.textContent = backN ? String(backN) : ''
    if (fwdCount) fwdCount.textContent = fwdN ? String(fwdN) : ''
  }

  private state(): Record<string, unknown> {
    return {
      current: this.current,
      back: [...this.backStack],
      forward: [...this.fwdStack],
      buttonsVisible: this.rootEl ? !this.rootEl.hidden : false,
    }
  }
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}
