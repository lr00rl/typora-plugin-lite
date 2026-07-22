import {
  CODEBLOCK_MARKER_CSS,
  Plugin,
  detectIndentUnit,
  editor,
  guideColumnsPerLine,
  indentGuideBackground,
  platform,
  splitWhitespace,
  type SettingsSchema,
} from '@typora-plugin-lite/core'

import { isProbablyBinary } from './fence.js'
import { HIGHLIGHT_LANGS, highlightLines } from './highlight.js'
import { languageFor } from './languages.js'

interface CodeViewerSettings extends Record<string, unknown> {
  enabled: boolean
  /** Files larger than this (bytes) are not previewed (a notice is shown). */
  maxBytes: number
  /** Cap on rendered lines, so a huge file doesn't build a giant DOM. */
  maxLines: number
  /** vim-listchars-style markers: · for spaces, » for tabs. */
  showWhitespace: boolean
  /** Vertical indent-alignment guides at every tab stop. */
  indentGuides: boolean
  /**
   * Per-extension language overrides set via the header picker
   * (managed by the picker itself; not shown in the settings form).
   */
  langOverrides: Record<string, string>
}

const DEFAULT_SETTINGS: CodeViewerSettings = {
  enabled: true,
  maxBytes: 4_000_000,
  maxLines: 50_000,
  showWhitespace: true,
  indentGuides: true,
  langOverrides: {},
}

/** How often to re-check the active file (a robust backup to the open hook). */
const POLL_MS = 400

/** tab-size of the pane (kept in sync with the CSS `tab-size` declaration). */
const TAB_SIZE = 4

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
/*
 * Height is set in JS (fitPane): the pane must match the VISIBLE editor area,
 * not the host's content height. The old inset:0 anchored the pane to a host
 * whose height came from the hidden-but-still-laid-out #write — i.e. the
 * markdown rendering of the very file being viewed — so scrolling past the
 * code revealed a giant blank tail (or clipped it). #write is now hidden with
 * display:none, and this pane is an internally-scrolling, viewport-sized box.
 */
#tpl-code-view-pane {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
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
#tpl-code-view-head .tpl-cv-ro {
  margin-left: auto;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--code-border-color, rgba(128,128,128,0.3));
  opacity: 0.7;
}
#tpl-code-view-lang {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid var(--code-border-color, rgba(128,128,128,0.3));
  border-radius: 5px;
  padding: 0 4px;
  height: 20px;
  max-width: 170px;
  cursor: pointer;
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
  /* grow to fill short files, but never shrink below content height —
     flex:1 would pin the box to the container and clip the background. */
  flex: 1 0 auto;
}
.tpl-cv-row { display: flex; white-space: pre; }
.tpl-cv-row:hover { background: rgba(128,128,128,0.06); }
/*
 * The line-number gutter is a ::before pseudo-element fed by data-ln.
 * Generated content is never part of a selection, so copying code out of the
 * pane can no longer leak line numbers into the clipboard (the old real-span
 * gutter did — every pasted line carried its number).
 *
 * box-sizing MUST be content-box here: Typora's global CSS sets border-box
 * everywhere, which makes min-width include the padding — the content area
 * then shrinks below one digit, the box grows with the digit count, and the
 * whole code column jogs sideways at every 9→10 / 99→100 transition.
 */
.tpl-cv-row::before {
  box-sizing: content-box;
  content: attr(data-ln);
  flex: 0 0 auto;
  min-width: var(--tpl-cv-gutter-ch, 4ch);
  padding: 0 1em 0 0.6em;
  text-align: right;
  color: var(--code-text-color, #999);
  opacity: 0.4;
  border-right: 1px solid var(--code-border-color, rgba(128,128,128,0.15));
  margin-right: 1em;
}
.tpl-cv-src { flex: 1 1 auto; background-repeat: no-repeat; }
/* Blank lines need height; generated ZWSP gives it without an uncopyable
   character ever entering the DOM text. */
.tpl-cv-src:empty::after { content: '\\200b'; }
#tpl-code-view-truncated {
  padding: 10px 16px;
  font-size: 12px;
  opacity: 0.55;
  border-top: 1px dashed var(--code-border-color, rgba(128,128,128,0.3));
}
/* Syntax tokens (cm-* class names, so themes can restyle them). The first
   color is the light value; light-dark() upgrades it where supported. */
#tpl-code-view-code .cm-keyword { color: #a626a4; color: light-dark(#a626a4, #c678dd); }
#tpl-code-view-code .cm-string { color: #3e8e2f; color: light-dark(#3e8e2f, #98c379); }
#tpl-code-view-code .cm-comment { color: #8a8f98; color: light-dark(#8a8f98, #8a8f98); font-style: italic; }
#tpl-code-view-code .cm-number { color: #b76b01; color: light-dark(#b76b01, #d19a66); }
#tpl-code-view-code .cm-atom { color: #b76b01; color: light-dark(#b76b01, #d19a66); }
#tpl-code-view-code .cm-builtin { color: #0184bc; color: light-dark(#0184bc, #56b6c2); }
#tpl-code-view-code .cm-property { color: #c14143; color: light-dark(#c14143, #e06c75); }
#tpl-code-view-code .cm-tag { color: #c14143; color: light-dark(#c14143, #e06c75); }
#tpl-code-view-code .cm-attribute { color: #986801; color: light-dark(#986801, #d19a66); }
#tpl-code-view-code .cm-meta { color: #8a8f98; color: light-dark(#8a8f98, #8a8f98); }
`
+ CODEBLOCK_MARKER_CSS

export default class CodeViewerPlugin extends Plugin<CodeViewerSettings> {
  static defaultSettings: CodeViewerSettings = { ...DEFAULT_SETTINGS }

  static settingsSchema: SettingsSchema<CodeViewerSettings> = {
    fields: {
      enabled: {
        kind: 'toggle',
        label: 'Enable read-only code viewer',
        description: 'Show non-Markdown text/code files as a read-only pane. The original file is never modified.',
      },
      showWhitespace: {
        kind: 'toggle',
        label: 'Show whitespace markers',
        description: 'vim listchars-style: a subtle dot for every space, » for every tab. Visual only — copying still yields the real characters.',
      },
      indentGuides: {
        kind: 'toggle',
        label: 'Show indent guides',
        description: 'Vertical alignment rules at every tab stop of a line\'s indentation.',
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
    order: ['enabled', 'showWhitespace', 'indentGuides', 'maxBytes', 'maxLines'],
  }

  private activePath = ''
  private pane: HTMLElement | null = null
  private paneHeight = 0
  private restores: Array<() => void> = []

  _init(...args: Parameters<Plugin<CodeViewerSettings>['_init']>): void {
    super._init(args[0], args[1], DEFAULT_SETTINGS)
  }

  onload(): void {
    this.registerCss(CSS)
    this.installSaveGuard()
    this.hookFileOpen()
    this.registerInterval(() => void this.sync(), POLL_MS)
    this.registerDomEvent(window, 'resize', () => this.fitPane())
    this.registerCommand({
      id: 'code-viewer:refresh',
      name: 'Code Viewer: Reload current file',
      callback: () => void this.sync(true),
    })
    this.addDisposable(() => this.teardown())
    // Settings toggles (whitespace, guides, enable) take effect without reload.
    this.addDisposable(this.settings.onChange(() => void this.sync(true)))
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
    if (!path || languageFor(this.currentFileName()) === null) {
      // Markdown or nothing open → normal editor.
      this.hidePane()
      return
    }

    if (this.activePath === path && this.pane && !force) {
      // Typora occasionally restores #write (mode switches, file churn);
      // keep it hidden and the pane fitted while a code file is active.
      this.hideWrite()
      this.fitPane()
      return
    }
    await this.renderPane(path)
  }

  /**
   * The language used for highlighting: the header picker's per-extension
   * override if one exists, else the filename-derived detection ('' = plain).
   */
  private effectiveLang(fileName: string): string {
    const override = this.settings.get('langOverrides')[langKey(fileName)]
    if (override != null) return override
    return languageFor(fileName) ?? ''
  }

  private async renderPane(path: string): Promise<void> {
    const lang = this.effectiveLang(this.currentFileName())
    let raw: string
    try {
      raw = await platform.fs.readText(path)
    } catch (err) {
      this.warn('failed to read', path, err)
      return
    }

    if (raw.length > this.settings.get('maxBytes')) {
      this.showTextPane(path, lang, `文件过大（${Math.round(raw.length / 1024)}KB），未预览`, null)
      this.activePath = path
      return
    }
    if (isProbablyBinary(raw)) {
      this.showTextPane(path, lang, '二进制文件，未预览', null)
      this.activePath = path
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
  /** Hide every #write so its markdown rendering stops shaping the layout. */
  private hideWrite(): void {
    for (const write of document.querySelectorAll<HTMLElement>('#write')) {
      write.style.display = 'none'
    }
  }

  /**
   * Pin the pane to the VISIBLE editor area: full width of the host (handled
   * by CSS left/right:0) and exactly the viewport height below its top edge.
   * Without this, the pane would inherit the host's content height — and with
   * #write display:none the host is ~0 tall, so the pane must size itself.
   */
  private fitPane(): void {
    if (!this.pane) return
    const top = this.pane.getBoundingClientRect().top
    const height = Math.max(200, Math.round(window.innerHeight - Math.max(0, top)))
    if (this.paneHeight !== height) {
      this.paneHeight = height
      this.pane.style.height = `${height}px`
    }
  }

  private ensurePane(): HTMLElement | null {
    if (this.pane && this.pane.isConnected) return this.pane
    const write = document.querySelector('#write') as HTMLElement | null
    const host = write?.parentElement
    if (!write || !host) return null

    // Make sure the host can anchor an absolutely-positioned pane.
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
    }
    this.hideWrite()

    const pane = document.createElement('div')
    pane.id = 'tpl-code-view-pane'
    host.appendChild(pane)
    this.pane = pane
    return pane
  }

  /** The header language picker: defaults to the detected/override language. */
  private buildLangSelect(path: string, lang: string): HTMLSelectElement {
    const select = document.createElement('select')
    select.id = 'tpl-code-view-lang'
    select.title = '高亮语言（按扩展名记住选择）'

    const shown = lang || 'text'
    const options = [...HIGHLIGHT_LANGS]
    if (!options.some(o => o.id === shown)) {
      options.push({ id: shown, label: shown })
    }
    for (const o of options) {
      const opt = document.createElement('option')
      opt.value = o.id
      opt.textContent = o.label
      select.appendChild(opt)
    }
    select.value = shown

    select.addEventListener('change', () => {
      const fileName = this.currentFileName()
      const key = langKey(fileName)
      const auto = languageFor(fileName) ?? ''
      const picked = select.value === 'text' ? '' : select.value
      const overrides = { ...this.settings.get('langOverrides') }
      if (picked === auto) delete overrides[key]
      else overrides[key] = picked
      this.settings.set('langOverrides', overrides)
      this.settings.save().catch(() => {})
      void this.renderPane(path)
    })
    return select
  }

  private showTextPane(path: string, lang: string, message: string | null, code: string | null): void {
    const pane = this.ensurePane()
    if (!pane) return
    this.hideWrite()

    while (pane.firstChild) pane.removeChild(pane.firstChild)

    // Header: dot · filename · language picker · read-only badge
    const head = document.createElement('div')
    head.id = 'tpl-code-view-head'
    const dot = document.createElement('span'); dot.className = 'tpl-cv-dot'
    const name = document.createElement('span'); name.className = 'tpl-cv-name'; name.textContent = basename(path)
    const langSelect = this.buildLangSelect(path, lang)
    const ro = document.createElement('span'); ro.className = 'tpl-cv-ro'; ro.textContent = '只读'
    head.append(dot, name, langSelect, ro)
    pane.appendChild(head)

    if (message !== null) {
      const status = document.createElement('div')
      status.id = 'tpl-code-view-truncated'
      status.textContent = message
      pane.appendChild(status)
      this.fitPane()
      return
    }

    // Code, line by line, with a gutter. textContent everywhere → no injection.
    const codeEl = document.createElement('div')
    codeEl.id = 'tpl-code-view-code'
    const lines = (code ?? '').split('\n')
    const maxLines = this.settings.get('maxLines')
    const shown = Math.min(lines.length, maxLines)
    const gutterCh = Math.max(3, String(shown).length + 1)
    codeEl.style.setProperty('--tpl-cv-gutter-ch', `${gutterCh}ch`)
    // Highlight exactly the rendered prefix: tokenizing from the file start
    // keeps multi-line state correct, and there is no work beyond the cap.
    const shownLines = lines.slice(0, shown)
    const tokenLines = highlightLines(shownLines.join('\n'), lang)
    const showWs = this.settings.get('showWhitespace')
    const guidesOn = this.settings.get('indentGuides')
    // The file's indent unit (2 for ··fn style, 4 for classic) drives guide
    // positions; blank lines inherit their block's guides.
    const indentUnit = detectIndentUnit(shownLines, TAB_SIZE)
    const guideCols = guideColumnsPerLine(shownLines, TAB_SIZE, indentUnit)
    // One background string per distinct guide set — lines share a handful.
    const guideCache = new Map<string, { image: string; size: string } | null>()

    const frag = document.createDocumentFragment()
    for (let i = 0; i < shown; i++) {
      const row = document.createElement('div')
      row.className = 'tpl-cv-row'
      row.dataset.ln = String(i + 1)
      const src = document.createElement('span')
      src.className = 'tpl-cv-src'
      if (lines[i]!.length > 0) {
        for (const token of tokenLines[i] ?? []) {
          if (!showWs) {
            src.appendChild(tokenSpan(token))
            continue
          }
          for (const chunk of splitWhitespace(token.text)) {
            src.appendChild(chunk.kind === 'text' ? tokenSpan({ text: chunk.text, cls: token.cls }) : wsSpan(chunk))
          }
        }
      }
      const cols = guideCols[i] ?? []
      if (guidesOn && cols.length > 0) {
        const key = cols.join(',')
        let bg = guideCache.get(key)
        if (bg === undefined) {
          bg = indentGuideBackground(cols, 'var(--tpl-guide-color, rgba(128,128,128,0.3))')
          guideCache.set(key, bg)
        }
        if (bg) {
          src.style.backgroundImage = bg.image
          src.style.backgroundSize = bg.size
        }
      }
      row.appendChild(src)
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
    this.fitPane()
  }

  private hidePane(): void {
    this.activePath = ''
    if (this.pane) { this.pane.remove(); this.pane = null }
    this.paneHeight = 0
    for (const write of document.querySelectorAll<HTMLElement>('#write')) {
      write.style.display = ''
    }
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

/**
 * The override-map key for a file: its lowercase extension, or the full
 * lowercase basename for extension-less files and dotfiles (Dockerfile,
 * .gitignore) — the same distinction languages.ts makes.
 */
function langKey(fileName: string): string {
  const base = basename(fileName).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1) : base
}

/** A plain text node, or a cm-* class span for a highlighted token. */
function tokenSpan(token: { text: string; cls: string | null }): Node {
  if (!token.cls) return document.createTextNode(token.text)
  const span = document.createElement('span')
  span.className = `cm-${token.cls}`
  span.textContent = token.text
  return span
}

/**
 * A whitespace-marker span. The original characters stay inside (so copy and
 * selection are unaffected); CSS makes them transparent and draws the · / »
 * markers on top.
 */
function wsSpan(chunk: { text: string; kind: string }): HTMLElement {
  const span = document.createElement('span')
  span.className = chunk.kind === 'space' ? 'tpl-ws-sp' : 'tpl-ws-tab'
  span.textContent = chunk.text
  return span
}
