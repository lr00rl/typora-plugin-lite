/**
 * Note Assistant: a keyboard-first related-notes palette plus a quiet,
 * read-only inline rendering of generated note-assistant blocks.
 *
 * Mod+; toggles the palette. Inside it: arrows move, Enter opens, Alt/⌥Enter
 * inserts a `[[wiki-link]]` into the document body (the durable action the
 * graph later indexes), Tab cycles 相关/链接/候选, Mod+R rebuilds the index.
 */

import { Plugin } from '@typora-plugin-lite/core'

import { BlockRenderer } from './block.js'
import { GraphStore } from './graph.js'
import { NotePalette } from './palette.js'
import { CSS } from './styles.js'

const HOTKEY = 'Mod+;'

export default class NoteAssistantPlugin extends Plugin {
  private store = new GraphStore()
  private palette: NotePalette | null = null
  private block: BlockRenderer | null = null

  onload(): void {
    this.registerCss(CSS)

    const palette = new NotePalette(this.store, message => this.showNotice(message))
    this.palette = palette
    this.block = new BlockRenderer(this.store, () => void palette.toggle())

    const writeEl = document.getElementById('write')
    if (writeEl) this.block.attach(writeEl)

    this.registerHotkey(HOTKEY, () => void palette.toggle())
    this.registerCommand({
      id: 'note-assistant:open',
      name: '笔记助手: 打开相关笔记',
      callback: () => void palette.toggle(),
    })
    this.registerCommand({
      id: 'note-assistant:rebuild-graph',
      name: '笔记助手: 重建索引',
      callback: () => this.rebuild(),
    })
    this.registerCommand({
      id: 'note-assistant:state',
      name: '笔记助手: 状态',
      callback: () => this.state(),
    })
  }

  onunload(): void {
    this.block?.detach()
    this.block = null
    this.palette?.dispose()
    this.palette = null
  }

  private async rebuild(): Promise<boolean> {
    if (this.palette?.isOpen) {
      return this.palette.rebuild()
    }
    if (this.store.rebuildInFlight) return false
    this.showNotice('正在重建索引…')
    const ok = await this.store.rebuild()
    this.showNotice(ok ? '索引已重建' : '索引重建失败')
    return ok
  }

  private state(): Record<string, unknown> {
    return this.store.stateSnapshot({
      paletteOpen: this.palette?.isOpen ?? false,
      inline: {
        processCount: this.block?.processCount ?? 0,
        renderedCount: this.block?.renderedCount ?? 0,
      },
    })
  }
}
