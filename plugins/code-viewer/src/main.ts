import { Plugin, editor, platform, type SettingsSchema } from '@typora-plugin-lite/core'

import { isProbablyBinary } from './fence.js'
import { languageFor } from './languages.js'

interface CodeViewerSettings extends Record<string, unknown> {
  enabled: boolean
  /** Files larger than this (bytes) are not previewed (a notice is shown). */
  maxBytes: number
  /** Cap on rendered lines, so a huge file doesn't build a giant DOM. */
  maxLines: number
}

const DEFAULT_SETTINGS: CodeViewerSettings = {
  enabled: true,
  maxBytes: 4_000_000,
  maxLines: 50_000,
}

/** How often to re-check the active file (a robust backup to the open hook). */
const POLL_MS = 400

/**
 * Safety model
 * ------------
 * The plugin NEVER modifies Typora's document. It reads the file off disk with
 * platform.fs and paints a separate read-only pane over the editor. Because the
 * editor's own content is left untouched, Typora has nothing to save — no
 * autosave, no quit-flush, no Cmd+S can ever rewrite the original file. (An
 * earlier design fed a fenced copy into the editor via reloadContent; that made
 * the document dirty, and a quit-time save leaked the fenced text back to disk.
 * Never again — we don't touch the document.)
 *
 * Two belt-and-suspenders layers on top of "don't touch the document":
 *   - markSaved() right after opening a code file, so it starts clean even if
 *     Typora's own markdown round-trip nudged the dirty flag.
 *   - the save-path guard below, which no-ops saveUseNode/saveAndBackup for any
 *     non-markdown file regardless of plugin state.
 */
const CSS = `
#tpl-code-view-pane {
  position: absolute;
  inset: 0;
  z-index: 20;
  overflow: auto;
  background: var(--bg-color, #fff);
  display: flex;
  flex-direction: column;
}
#tpl-code-view-head {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  background: var(--bg-color, #fff);
  border-bottom: 1px solid var(--code-border-color, rgba(128,128,128,0.25));
  color: var(--text-color, inherit);
  flex-shrink: 0;
  user-select: none;
}
#tpl-code-view-head .tpl-cv-dot { width: 7px; height: 7px; border-radius: 50%; background: #4caf50; }
#tpl-code-view-head .tpl-cv-name { font-weight: 600; }
#tpl-code-view-head .tpl-cv-meta { opacity: 0.5; }
#tpl-code-view-head .tpl-cv-ro {
  margin-left: auto;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--code-border-color, rgba(128,128,128,0.3));
  opacity: 0.7;
}
#tpl-code-view-code {
  margin: 0;
  padding: 12px 0 40px;
  font-family: var(--font-mono, 'SF Mono', 'Fira Code', Consolas, monospace);
  font-size: 0.9em;
  line-height: 1.55;
  color: var(--code-text-color, var(--text-color, #24292e));
  background: var(--code-bg-color, transparent);
  tab-size: 4;
  flex: 1;
}
.tpl-cv-row { display: flex; white-space: pre; }
.tpl-cv-row:hover { background: rgba(128,128,128,0.06); }
.tpl-cv-ln {
  flex: 0 0 auto;
  min-width: 3.5em;
  padding: 0 1em 0 0.6em;
  text-align: right;
  color: var(--code-text-color, #999);
  opacity: 0.4;
  user-select: none;
  border-right: 1px solid var(--code-border-color, rgba(128,128,128,0.15));
  margin-right: 1em;
}
.tpl-cv-src { flex: 1 1 auto; }
#tpl-code-view-truncated {
  padding: 10px 16px;
  font-size: 12px;
  opacity: 0.55;
  border-top: 1px dashed var(--code-border-color, rgba(128,128,128,0.3));
}
`

export default class CodeViewerPlugin extends Plugin<CodeViewerSettings> {
  static defaultSettings: CodeViewerSettings = { ...DEFAULT_SETTINGS }

  static settingsSchema: SettingsSchema<CodeViewerSettings> = {
    fields: {
      enabled: {
        kind: 'toggle',
        label: 'Enable read-only code viewer',
        description: 'Show non-Markdown text/code files as a read-only pane. The original file is never modified.',
      },
      maxBytes: {
        kind: 'number',
        label: 'Max file size (bytes)',
        description: 'Files larger than this are not previewed.',
        min: 10_000,
        max: 50_000_000,
      },
      maxLines: {
        kind: 'number',
        label: 'Max lines rendered',
        description: 'Lines beyond this are omitted (a notice is shown).',
        min: 500,
        max: 500_000,
      },
    },
    order: ['enabled', 'maxBytes', 'maxLines'],
  }

  private activePath = ''
  private pane: HTMLElement | null = null
  private restores: Array<() => void> = []

  _init(...args: Parameters<Plugin<CodeViewerSettings>['_init']>): void {
    super._init(args[0], args[1], DEFAULT_SETTINGS)
  }

  onload(): void {
    this.registerCss(CSS)
    this.installSaveGuard()
    this.hookFileOpen()
    this.registerInterval(() => void this.sync(), POLL_MS)
    this.registerCommand({
      id: 'code-viewer:refresh',
      name: 'Code Viewer: Reload current file',
      callback: () => void this.sync(true),
    })
    this.addDisposable(() => this.teardown())
    void this.sync()
  }

  onunload(): void {
    this.teardown()
  }

  private warn(...args: unknown[]): void { console.warn('[tpl:code-viewer]', ...args) }

  private teardown(): void {
    for (const restore of this.restores) {
      try { restore() } catch {}
    }
    this.restores = []
    this.hidePane()
  }

  // -------------------------------------------------------------------------
  // Save protection (defense-in-depth; the real safety is "never dirty the doc")
  // -------------------------------------------------------------------------
  private installSaveGuard(): void {
    const file = (window as any).File
    if (!file) return
    const plugin = this
    for (const method of ['saveUseNode', 'saveAndBackup'] as const) {
      const original = file[method]
      if (typeof original !== 'function') continue
      file[method] = function guarded(this: unknown, ...args: unknown[]) {
        if (plugin.shouldBlockSave()) return Promise.resolve()
        return original.apply(this, args)
      }
      this.restores.push(() => { file[method] = original })
    }
  }

  private shouldBlockSave(): boolean {
    if (!this.settings.get('enabled')) return false
    return languageFor(this.currentFileName()) !== null
  }

  private hookFileOpen(): void {
    const file = (window as any).File
    if (typeof file?.onFileOpened !== 'function') return
    const original = file.onFileOpened
    const plugin = this
    file.onFileOpened = function hooked(this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args)
      queueMicrotask(() => void plugin.sync())
      return result
    }
    this.restores.push(() => { file.onFileOpened = original })
  }

  private currentFileName(): string {
    return editor.getFileName() || basename(editor.getFilePath())
  }

  private async sync(force = false): Promise<void> {
    if (!this.settings.get('enabled')) { this.hidePane(); return }

    const path = editor.getFilePath()
    const lang = path ? languageFor(this.currentFileName()) : null

    if (lang === null) {
      // Markdown or nothing open → normal editor.
      this.hidePane()
      return
    }

    if (this.activePath === path && this.pane && !force) return
    await this.renderPane(path, lang)
  }

  private async renderPane(path: string, lang: string): Promise<void> {
    let raw: string
    try {
      raw = await platform.fs.readText(path)
    } catch (err) {
      this.warn('failed to read', path, err)
      return
    }

    if (raw.length > this.settings.get('maxBytes')) {
      this.showTextPane(path, lang, `文件过大（${Math.round(raw.length / 1024)}KB），未预览`, null)
      return
    }
    if (isProbablyBinary(raw)) {
      this.showTextPane(path, lang, '二进制文件，未预览', null)
      return
    }

    // Belt-and-suspenders: a code file should be a clean document (we never
    // write to it). Force-clean in case Typora's own round-trip dirtied it.
    this.markClean()

    this.showTextPane(path, lang, null, raw)
    this.activePath = path
  }

  // -------------------------------------------------------------------------
  // The read-only pane
  // -------------------------------------------------------------------------
  private ensurePane(): HTMLElement | null {
    if (this.pane && this.pane.isConnected) return this.pane
    const write = document.querySelector('#write') as HTMLElement | null
    const host = write?.parentElement
    if (!write || !host) return null

    // Make sure the host can anchor an absolutely-positioned pane.
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
    }
    write.style.visibility = 'hidden'

    const pane = document.createElement('div')
    pane.id = 'tpl-code-view-pane'
    host.appendChild(pane)
    this.pane = pane

    this.restores.push(() => {
      write.style.visibility = ''
    })
    return pane
  }

  private showTextPane(path: string, lang: string, message: string | null, code: string | null): void {
    const pane = this.ensurePane()
    if (!pane) return
    const write = document.querySelector('#write') as HTMLElement | null
    if (write) write.style.visibility = 'hidden'

    while (pane.firstChild) pane.removeChild(pane.firstChild)

    // Header
    const head = document.createElement('div')
    head.id = 'tpl-code-view-head'
    const dot = document.createElement('span'); dot.className = 'tpl-cv-dot'
    const name = document.createElement('span'); name.className = 'tpl-cv-name'; name.textContent = basename(path)
    const meta = document.createElement('span'); meta.className = 'tpl-cv-meta'; meta.textContent = lang || 'text'
    const ro = document.createElement('span'); ro.className = 'tpl-cv-ro'; ro.textContent = '只读'
    head.append(dot, name, meta, ro)
    pane.appendChild(head)

    if (message !== null) {
      const status = document.createElement('div')
      status.id = 'tpl-code-view-truncated'
      status.textContent = message
      pane.appendChild(status)
      return
    }

    // Code, line by line, with a gutter. textContent everywhere → no injection.
    const codeEl = document.createElement('div')
    codeEl.id = 'tpl-code-view-code'
    const lines = (code ?? '').split('\n')
    const maxLines = this.settings.get('maxLines')
    const shown = Math.min(lines.length, maxLines)
    const gutterCh = Math.max(3, String(shown).length + 1)

    const frag = document.createDocumentFragment()
    for (let i = 0; i < shown; i++) {
      const row = document.createElement('div')
      row.className = 'tpl-cv-row'
      const ln = document.createElement('span')
      ln.className = 'tpl-cv-ln'
      ln.style.minWidth = `${gutterCh}ch`
      ln.textContent = String(i + 1)
      const src = document.createElement('span')
      src.className = 'tpl-cv-src'
      // A blank line still needs height; a zero-width space keeps the row.
      src.textContent = lines[i]!.length ? lines[i]! : '​'
      row.append(ln, src)
      frag.appendChild(row)
    }
    codeEl.appendChild(frag)
    pane.appendChild(codeEl)

    if (lines.length > shown) {
      const trunc = document.createElement('div')
      trunc.id = 'tpl-code-view-truncated'
      trunc.textContent = `… 仅显示前 ${shown} 行，共 ${lines.length} 行`
      pane.appendChild(trunc)
    }
  }

  private hidePane(): void {
    this.activePath = ''
    if (this.pane) { this.pane.remove(); this.pane = null }
    const write = document.querySelector('#write') as HTMLElement | null
    if (write) write.style.visibility = ''
  }

  private markClean(): void {
    try { (window as any).File?.markSaved?.() } catch {}
  }
}

function basename(path: string): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}
