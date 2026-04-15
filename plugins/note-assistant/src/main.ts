import { Plugin, editor, platform } from '@typora-plugin-lite/core'

interface RelatedReason {
  explicitLink?: boolean
  backlink?: boolean
  sameDirectory?: boolean
  sameTopLevel?: boolean
  sharedTerms?: string[]
}

interface RelatedItem {
  relPath: string
  title: string
  score: number
  reasons: RelatedReason
}

interface GraphNote {
  relPath: string
  title: string
  tags?: string[]
  aliases?: string[]
  headings?: string[]
  explicitLinks?: string[]
  backlinks?: string[]
  related?: RelatedItem[]
}

interface GraphStats {
  totalNotes: number
  notesWithFrontmatter: number
  notesWithWikiLinks: number
  explicitLinkEdges: number
  notesWithRelated: number
}

interface GraphFile {
  schemaVersion: number
  generatedAt: string
  root: string
  limit: number
  stats: GraphStats
  notes: GraphNote[]
}

const HOTKEY = 'Mod+;'
const GRAPH_DIR = '.note-assistant'
const GRAPH_FILE = 'graph.json'
const BUILD_SCRIPT = 'tools/note-assistant/build-graph.mjs'
const PANEL_ID = 'tpl-note-assistant'

const CSS = `
#${PANEL_ID}-overlay {
  position: fixed;
  inset: 0;
  z-index: 99998;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 8vh;
  background: rgba(0, 0, 0, 0.45);
}
#${PANEL_ID}-panel {
  width: min(920px, 94vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 12px;
  background: var(--bg-color, #fff);
  color: var(--text-color, inherit);
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.18));
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
}
#${PANEL_ID}-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
}
#${PANEL_ID}-title-wrap {
  min-width: 0;
}
#${PANEL_ID}-title {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.25;
  margin-bottom: 4px;
  word-break: break-word;
}
#${PANEL_ID}-subtitle {
  opacity: 0.62;
  font-size: 12px;
  line-height: 1.4;
  word-break: break-all;
}
#${PANEL_ID}-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.${PANEL_ID}-btn {
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.22));
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
}
.${PANEL_ID}-btn:hover {
  background: rgba(127, 127, 127, 0.08);
}
#${PANEL_ID}-body {
  overflow: auto;
  padding: 10px 16px 16px;
}
.${PANEL_ID}-status {
  padding: 18px 6px;
  opacity: 0.68;
  line-height: 1.5;
}
.${PANEL_ID}-section {
  margin-top: 14px;
}
.${PANEL_ID}-section:first-child {
  margin-top: 0;
}
.${PANEL_ID}-section-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.48;
  margin: 0 0 8px;
}
.${PANEL_ID}-card {
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.14));
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.${PANEL_ID}-row-top {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.${PANEL_ID}-check {
  margin-top: 3px;
}
.${PANEL_ID}-row-main {
  flex: 1;
  min-width: 0;
}
.${PANEL_ID}-row-title {
  font-weight: 600;
  line-height: 1.35;
  margin-bottom: 3px;
  word-break: break-word;
}
.${PANEL_ID}-row-path {
  font-size: 12px;
  opacity: 0.65;
  word-break: break-all;
}
.${PANEL_ID}-row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.${PANEL_ID}-badge {
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 8px;
  background: rgba(127, 127, 127, 0.1);
  opacity: 0.88;
}
.${PANEL_ID}-reasons {
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.74;
  line-height: 1.45;
}
.${PANEL_ID}-row-actions {
  display: flex;
  gap: 8px;
}
.${PANEL_ID}-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px 14px;
  border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
  font-size: 12px;
  opacity: 0.66;
}
`

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/')
}

function splitPath(input: string): string[] {
  return normalizePath(input).split('/').filter(Boolean)
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim()) return value
  }
  return ''
}

function getRootPrefix(input: string): string {
  const normalized = normalizePath(input)
  const drive = normalized.match(/^[A-Za-z]:/)
  if (drive) return drive[0].toLowerCase()
  return normalized.startsWith('/') ? '/' : ''
}

function relPathFromRoot(absPath: string, root: string): string {
  const normalizedAbs = normalizePath(absPath)
  const normalizedRoot = normalizePath(root)
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : normalizedRoot + '/'
  if (normalizedAbs.startsWith(prefix)) {
    return normalizedAbs.slice(prefix.length)
  }
  return normalizedAbs
}

function relPathFromDir(absPath: string, baseDir: string): string {
  const target = normalizePath(absPath)
  const base = normalizePath(baseDir)
  if (!base || getRootPrefix(target) !== getRootPrefix(base)) return target

  const targetParts = splitPath(target)
  const baseParts = splitPath(base)
  let shared = 0
  while (
    shared < targetParts.length &&
    shared < baseParts.length &&
    targetParts[shared] === baseParts[shared]
  ) {
    shared += 1
  }

  const up = baseParts.slice(shared).map(() => '..')
  const down = targetParts.slice(shared)
  return [...up, ...down].join('/') || '.'
}

function withoutMarkdownExt(input: string): string {
  return input.replace(/\.(md|markdown)$/i, '')
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch
  ))
}

export default class NoteAssistantPlugin extends Plugin {
  private overlay: HTMLDivElement | null = null
  private bodyEl: HTMLDivElement | null = null
  private titleEl: HTMLDivElement | null = null
  private subtitleEl: HTMLDivElement | null = null
  private footerEl: HTMLDivElement | null = null
  private graphCache: GraphFile | null = null
  private graphPath = ''
  private graphRoot = ''
  private graphMtime = 0
  private noteMap: Map<string, GraphNote> = new Map()
  private selectionMap = new Map<string, HTMLInputElement>()
  private rebuildInFlight = false
  private keydownHandler: ((evt: KeyboardEvent) => void) | null = null

  onload(): void {
    this.registerHotkey(HOTKEY, () => void this.open())
    this.registerCommand({
      id: 'note-assistant:open',
      name: 'Note Assistant: Open',
      callback: () => this.open(),
    })
    this.registerCommand({
      id: 'note-assistant:rebuild-graph',
      name: 'Note Assistant: Rebuild Graph',
      callback: () => void this.rebuildGraph(),
    })
  }

  onunload(): void {
    this.close()
  }

  private async open(): Promise<void> {
    if (this.overlay) {
      this.close()
      return
    }
    this.buildModal()
    await this.renderCurrentNote()
  }

  private close(): void {
    this.selectionMap.clear()
    if (this.keydownHandler) {
      window.removeEventListener('keydown', this.keydownHandler)
      this.keydownHandler = null
    }
    this.overlay?.remove()
    this.overlay = null
    this.bodyEl = null
    this.titleEl = null
    this.subtitleEl = null
    this.footerEl = null
  }

  private buildModal(): void {
    if (!document.getElementById(`${PANEL_ID}-style`)) {
      const style = document.createElement('style')
      style.id = `${PANEL_ID}-style`
      style.textContent = CSS
      document.head.appendChild(style)
    }

    const overlay = document.createElement('div')
    overlay.id = `${PANEL_ID}-overlay`
    overlay.addEventListener('click', evt => {
      if (evt.target === overlay) this.close()
    })

    const panel = document.createElement('div')
    panel.id = `${PANEL_ID}-panel`
    panel.addEventListener('click', evt => evt.stopPropagation())

    const header = document.createElement('div')
    header.id = `${PANEL_ID}-header`

    const titleWrap = document.createElement('div')
    titleWrap.id = `${PANEL_ID}-title-wrap`
    const title = document.createElement('div')
    title.id = `${PANEL_ID}-title`
    title.textContent = 'Note Assistant'
    const subtitle = document.createElement('div')
    subtitle.id = `${PANEL_ID}-subtitle`
    subtitle.textContent = 'Loading...'
    titleWrap.appendChild(title)
    titleWrap.appendChild(subtitle)

    const actions = document.createElement('div')
    actions.id = `${PANEL_ID}-actions`
    actions.appendChild(this.makeButton('Refresh', () => void this.renderCurrentNote(true)))
    actions.appendChild(this.makeButton('Rebuild Graph', () => void this.rebuildGraph()))
    actions.appendChild(this.makeButton('Insert Selected', () => this.insertSelectedLinks()))

    header.appendChild(titleWrap)
    header.appendChild(actions)

    const body = document.createElement('div')
    body.id = `${PANEL_ID}-body`

    const footer = document.createElement('div')
    footer.id = `${PANEL_ID}-footer`
    footer.innerHTML = `<div>${escapeHtml(HOTKEY)} to open, Esc to close</div><div></div>`

    panel.appendChild(header)
    panel.appendChild(body)
    panel.appendChild(footer)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)

    this.overlay = overlay
    this.bodyEl = body
    this.titleEl = title
    this.subtitleEl = subtitle
    this.footerEl = footer

    this.keydownHandler = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') this.close()
    }
    window.addEventListener('keydown', this.keydownHandler)
  }

  private makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = `${PANEL_ID}-btn`
    btn.textContent = label
    btn.addEventListener('click', evt => {
      evt.preventDefault()
      onClick()
    })
    return btn
  }

  private getCurrentSearchRoots(): string[] {
    const win = window as any
    const watched = editor.getWatchedFolder()
    const currentFile = editor.getFilePath()
    const mountFolder = firstNonEmpty(
      watched,
      win.File?.getMountFolder?.(),
      win._options?.mountFolder,
      currentFile ? platform.path.dirname(currentFile) : '',
    )
    return [...new Set([watched, mountFolder, currentFile ? platform.path.dirname(currentFile) : ''].filter((value): value is string => !!value))]
  }

  private getFallbackRootDir(): string {
    return firstNonEmpty(editor.getWatchedFolder(), this.graphRoot, editor.getFilePath() ? platform.path.dirname(editor.getFilePath()) : '')
  }

  private async findUpwardsForFile(relativePath: string): Promise<{ root: string; absPath: string } | null> {
    for (const start of this.getCurrentSearchRoots()) {
      let dir = start
      const seen = new Set<string>()
      while (dir && !seen.has(dir)) {
        seen.add(dir)
        const candidate = platform.path.join(dir, relativePath)
        if (await platform.fs.exists(candidate)) {
          return { root: dir, absPath: candidate }
        }
        const parent = platform.path.dirname(dir)
        if (!parent || parent === dir) break
        dir = parent
      }
    }
    return null
  }

  private async loadGraph(force = false): Promise<GraphFile | null> {
    const located = await this.findUpwardsForFile(platform.path.join(GRAPH_DIR, GRAPH_FILE))
    if (!located) {
      this.graphCache = null
      this.graphPath = ''
      this.graphRoot = ''
      this.graphMtime = 0
      this.noteMap.clear()
      return null
    }

    const stat = await platform.fs.stat(located.absPath)
    const mtime = stat.mtimeMs ?? 0
    if (
      this.graphCache &&
      !force &&
      this.graphPath === located.absPath &&
      this.graphRoot === located.root &&
      this.graphMtime === mtime
    ) {
      return this.graphCache
    }

    try {
      const text = await platform.fs.readText(located.absPath)
      const parsed = JSON.parse(text) as GraphFile
      this.graphCache = parsed
      this.graphPath = located.absPath
      this.graphRoot = located.root
      this.graphMtime = mtime
      this.noteMap = new Map(parsed.notes.map(note => [note.relPath, note]))
      return parsed
    } catch (err) {
      console.error('[tpl:note-assistant] failed to load graph', err)
      this.graphCache = null
      this.graphPath = ''
      this.graphRoot = ''
      this.graphMtime = 0
      this.noteMap.clear()
      return null
    }
  }

  private async renderCurrentNote(force = false): Promise<void> {
    if (!this.bodyEl || !this.titleEl || !this.subtitleEl || !this.footerEl) return

    const currentFile = editor.getFilePath()
    const graph = await this.loadGraph(force)
    const root = graph?.root || this.graphRoot || this.getFallbackRootDir()

    if (!root || !currentFile) {
      this.renderStatus('Open the note inside a watched folder first. The plugin needs a vault root.')
      this.titleEl.textContent = 'Note Assistant'
      this.subtitleEl.textContent = 'No watched folder detected'
      return
    }

    const relPath = relPathFromRoot(currentFile, root)
    const note = graph ? this.noteMap.get(relPath) : null

    this.titleEl.textContent = note?.title || platform.path.basename(currentFile)
    this.subtitleEl.textContent = relPath

    if (!graph) {
      this.renderStatus(
        `Missing ${GRAPH_DIR}/${GRAPH_FILE}. Run the vault generator first or use “Rebuild Graph” if ${BUILD_SCRIPT} exists in the vault.`,
      )
      this.setFooter(root, 'graph missing')
      return
    }

    if (!note) {
      this.renderStatus(
        'The current file is not present in the generated graph. Refresh or rebuild the graph after adding this file.',
      )
      this.setFooter(root, `${graph.stats.totalNotes} indexed notes`)
      return
    }

    this.selectionMap.clear()
    this.bodyEl.innerHTML = ''

    const explicit = (note.explicitLinks || [])
      .map(item => this.noteMap.get(item))
      .filter(Boolean) as GraphNote[]
    const backlinks = (note.backlinks || [])
      .map(item => this.noteMap.get(item))
      .filter(Boolean) as GraphNote[]

    this.bodyEl.appendChild(this.renderMetaSection(note, graph))
    this.bodyEl.appendChild(this.renderLinkSection('Backlinks', backlinks, currentFile))
    this.bodyEl.appendChild(this.renderLinkSection('Explicit Links', explicit, currentFile))
    this.bodyEl.appendChild(this.renderRelatedSection(note.related || [], currentFile))

    this.setFooter(root, `${graph.stats.totalNotes} indexed · generated ${graph.generatedAt}`)
  }

  private renderStatus(message: string): void {
    if (!this.bodyEl) return
    this.bodyEl.innerHTML = `<div class="${PANEL_ID}-status">${escapeHtml(message)}</div>`
  }

  private renderMetaSection(note: GraphNote, graph: GraphFile): HTMLElement {
    const section = document.createElement('section')
    section.className = `${PANEL_ID}-section`
    section.innerHTML = `
      <div class="${PANEL_ID}-section-title">Current Note</div>
      <div class="${PANEL_ID}-card">
        <div class="${PANEL_ID}-row-title">${escapeHtml(note.title)}</div>
        <div class="${PANEL_ID}-reasons">
          tags: ${escapeHtml((note.tags || []).join(', ') || 'none')}<br>
          aliases: ${escapeHtml((note.aliases || []).join(', ') || 'none')}<br>
          headings: ${escapeHtml((note.headings || []).slice(0, 4).join(' · ') || 'none')}<br>
          graph schema: ${graph.schemaVersion}
        </div>
      </div>
    `
    return section
  }

  private renderLinkSection(label: string, notes: GraphNote[], currentFile: string): HTMLElement {
    const section = document.createElement('section')
    section.className = `${PANEL_ID}-section`
    section.innerHTML = `<div class="${PANEL_ID}-section-title">${escapeHtml(label)}</div>`

    if (!notes.length) {
      const empty = document.createElement('div')
      empty.className = `${PANEL_ID}-status`
      empty.textContent = `No ${label.toLowerCase()}.`
      section.appendChild(empty)
      return section
    }

    for (const note of notes.slice(0, 10)) {
      const item: RelatedItem = {
        relPath: note.relPath,
        title: note.title,
        score: 0,
        reasons: {},
      }
      section.appendChild(this.renderRelatedCard(item, currentFile, false))
    }
    return section
  }

  private renderRelatedSection(items: RelatedItem[], currentFile: string): HTMLElement {
    const section = document.createElement('section')
    section.className = `${PANEL_ID}-section`
    section.innerHTML = `<div class="${PANEL_ID}-section-title">Suggested Connections</div>`

    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = `${PANEL_ID}-status`
      empty.textContent = 'No related suggestions found for this note.'
      section.appendChild(empty)
      return section
    }

    for (const item of items) {
      section.appendChild(this.renderRelatedCard(item, currentFile, true))
    }
    return section
  }

  private renderRelatedCard(item: RelatedItem, currentFile: string, selectable: boolean): HTMLElement {
    const currentDir = normalizePath(platform.path.dirname(currentFile))
    const root = this.graphRoot || this.getFallbackRootDir()
    const absTarget = platform.path.join(root, item.relPath)
    const relative = withoutMarkdownExt(relPathFromDir(absTarget, currentDir))

    const card = document.createElement('div')
    card.className = `${PANEL_ID}-card`

    const top = document.createElement('div')
    top.className = `${PANEL_ID}-row-top`

    if (selectable) {
      const check = document.createElement('input')
      check.className = `${PANEL_ID}-check`
      check.type = 'checkbox'
      check.checked = this.selectionMap.size < 3
      this.selectionMap.set(item.relPath, check)
      top.appendChild(check)
    }

    const main = document.createElement('div')
    main.className = `${PANEL_ID}-row-main`

    const title = document.createElement('div')
    title.className = `${PANEL_ID}-row-title`
    title.textContent = item.title

    const relPath = document.createElement('div')
    relPath.className = `${PANEL_ID}-row-path`
    relPath.textContent = item.relPath

    const meta = document.createElement('div')
    meta.className = `${PANEL_ID}-row-meta`
    if (item.score) meta.appendChild(this.makeBadge(`score ${item.score}`))
    if (item.reasons.explicitLink) meta.appendChild(this.makeBadge('explicit'))
    if (item.reasons.backlink) meta.appendChild(this.makeBadge('backlink'))
    if (item.reasons.sameDirectory) meta.appendChild(this.makeBadge('same dir'))
    if (item.reasons.sameTopLevel) meta.appendChild(this.makeBadge('same top'))

    const reasons = document.createElement('div')
    reasons.className = `${PANEL_ID}-reasons`
    reasons.textContent = item.reasons.sharedTerms?.length
      ? `shared: ${item.reasons.sharedTerms.slice(0, 6).join(', ')}`
      : `insert: [[${relative}|${item.title}]]`

    main.appendChild(title)
    main.appendChild(relPath)
    main.appendChild(meta)
    main.appendChild(reasons)

    const actions = document.createElement('div')
    actions.className = `${PANEL_ID}-row-actions`
    actions.appendChild(this.makeButton('Open', () => void this.openNote(item.relPath)))

    top.appendChild(main)
    top.appendChild(actions)
    card.appendChild(top)
    return card
  }

  private makeBadge(label: string): HTMLElement {
    const badge = document.createElement('span')
    badge.className = `${PANEL_ID}-badge`
    badge.textContent = label
    return badge
  }

  private async openNote(relPath: string): Promise<void> {
    const root = this.graphRoot || this.getFallbackRootDir()
    if (!root) return
    try {
      await editor.openFile(platform.path.join(root, relPath))
      await this.renderCurrentNote()
    } catch (err) {
      console.error('[tpl:note-assistant] openNote failed', err)
      this.showNotice('Failed to open note')
    }
  }

  private insertSelectedLinks(): void {
    const currentFile = editor.getFilePath()
    const root = this.graphRoot || this.getFallbackRootDir()
    if (!currentFile || !root) return

    const currentDir = normalizePath(platform.path.dirname(currentFile))
    const selected = [...this.selectionMap.entries()]
      .filter(([, input]) => input.checked)
      .map(([relPath]) => {
        const note = this.noteMap.get(relPath)
        if (!note) return null
        const relative = withoutMarkdownExt(
          relPathFromDir(platform.path.join(root, relPath), currentDir),
        )
        return `- [[${relative}|${note.title}]]`
      })
      .filter(Boolean) as string[]

    if (!selected.length) {
      this.showNotice('No links selected')
      return
    }

    editor.insertText(`\n## Related Notes\n${selected.join('\n')}\n`)
    this.showNotice(`Inserted ${selected.length} links`)
  }

  private async rebuildGraph(): Promise<void> {
    if (this.rebuildInFlight) return

    const located = await this.findUpwardsForFile(BUILD_SCRIPT)
    if (!located) {
      this.showNotice(`Missing ${BUILD_SCRIPT}`)
      return
    }

    this.rebuildInFlight = true
    this.showNotice('Rebuilding note graph...')
    try {
      const cmd = `node ${platform.shell.escape(located.absPath)} --root ${platform.shell.escape(located.root)}`
      await platform.shell.run(cmd, { cwd: located.root, timeout: 120_000 })
      this.graphCache = null
      await this.renderCurrentNote(true)
      this.showNotice('Graph rebuilt')
    } catch (err) {
      console.error('[tpl:note-assistant] rebuildGraph failed', err)
      this.showNotice('Graph rebuild failed')
    } finally {
      this.rebuildInFlight = false
    }
  }

  private setFooter(root: string, detail: string): void {
    if (!this.footerEl) return
    this.footerEl.innerHTML = `<div>${escapeHtml(root)}</div><div>${escapeHtml(detail)}</div>`
  }
}
