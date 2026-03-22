import { Plugin, editor } from '@typora-plugin-lite/core'
import { padMarkdown } from './pangu.js'

export default class MdPaddingPlugin extends Plugin {
  onload(): void {
    console.log('[tpl:md-padding] onload, registering Mod+Shift+Space')
    this.registerHotkey('Mod+Shift+Space', () => this.formatDocument())

    this.registerCommand({
      id: 'md-padding:format',
      name: 'Format: Add CJK Spacing',
      callback: () => this.formatDocument(),
    })
  }

  private formatDocument(): void {
    console.log('[tpl:md-padding] formatDocument triggered')
    try {
      const markdown = editor.getMarkdown()
      if (!markdown) {
        this.showNotice('Cannot read document content')
        console.warn('[tpl:md-padding] getMarkdown returned empty')
        return
      }
      const formatted = padMarkdown(markdown)

      if (formatted !== markdown) {
        editor.setMarkdown(formatted)
        this.showNotice('Pangu spacing applied')
      } else {
        this.showNotice('No changes needed')
      }
    } catch (err) {
      console.error('[tpl:md-padding] format error:', err)
      this.showNotice('Format error — check console')
    }
  }
}
