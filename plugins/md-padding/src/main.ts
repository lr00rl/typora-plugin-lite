import { Plugin, editor } from '@typora-plugin-lite/core'
import { padMarkdown } from './pangu.js'

export default class MdPaddingPlugin extends Plugin {
  onload(): void {
    this.registerHotkey('Mod+Shift+Space', () => this.formatDocument())

    this.registerCommand({
      id: 'md-padding:format',
      name: 'Format: Add CJK Spacing',
      callback: () => this.formatDocument(),
    })
  }

  private formatDocument(): void {
    const markdown = editor.getMarkdown()
    const formatted = padMarkdown(markdown)

    if (formatted !== markdown) {
      editor.setMarkdown(formatted)
      this.showNotice('Pangu spacing applied')
    } else {
      this.showNotice('No changes needed')
    }
  }
}
