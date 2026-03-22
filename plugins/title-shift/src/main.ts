import { Plugin, editor } from '@typora-plugin-lite/core'

const HEADING_RE = /^(#{1,6})\s/

export default class TitleShiftPlugin extends Plugin {
  onload(): void {
    this.registerCommand({
      id: 'title-shift:increase',
      name: 'Headings: Increase Level (h2→h1)',
      callback: () => this.shiftHeadings(-1),
    })

    this.registerCommand({
      id: 'title-shift:decrease',
      name: 'Headings: Decrease Level (h1→h2)',
      callback: () => this.shiftHeadings(+1),
    })

    this.registerHotkey('Mod+Shift+Up', () => this.shiftHeadings(-1))
    this.registerHotkey('Mod+Shift+Down', () => this.shiftHeadings(+1))
  }

  private shiftHeadings(delta: number): void {
    const markdown = editor.getMarkdown()
    const lines = markdown.split('\n')
    let changed = false
    let inFenced = false

    const result = lines.map(line => {
      // Track fenced code blocks
      if (line.trimStart().startsWith('```') || line.trimStart().startsWith('~~~')) {
        inFenced = !inFenced
        return line
      }
      if (inFenced) return line

      const match = line.match(HEADING_RE)
      if (!match) return line

      const currentLevel = match[1].length
      const newLevel = currentLevel + delta

      if (newLevel < 1 || newLevel > 6) return line

      changed = true
      return '#'.repeat(newLevel) + line.substring(match[1].length)
    })

    if (changed) {
      editor.setMarkdown(result.join('\n'))
      this.showNotice(`Headings ${delta < 0 ? 'increased' : 'decreased'} by 1 level`)
    } else {
      this.showNotice('No headings to shift (boundary reached)')
    }
  }
}
