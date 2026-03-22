/**
 * Editor API — thin wrapper around Typora's editor globals.
 * Provides getMarkdown, setMarkdown, waitForEditor utilities.
 */

function getEditor(): TyporaEditor | undefined {
  return (window as any).File?.editor
}

export const editor = {
  /** Get the current markdown content of the document. */
  getMarkdown(): string {
    const ed = getEditor()
    if (ed) return ed.getMarkdown()
    // Fallback: try nodeMap
    return ed?.nodeMap?.toMark?.() ?? ''
  },

  /**
   * Replace the entire document markdown content.
   * Uses File.reloadContent which handles undo history.
   */
  setMarkdown(content: string): void {
    const f = (window as any).File
    if (f?.reloadContent) {
      f.reloadContent(content, { skipStore: false })
    }
  },

  /** Get the current file path. */
  getFilePath(): string {
    const f = (window as any).File
    return f?.bundle?.filePath ?? f?.filePath ?? ''
  },

  /** Get the current file name. */
  getFileName(): string {
    const f = (window as any).File
    return f?.bundle?.fileName ?? ''
  },

  /** Check if the current document has unsaved changes. */
  hasUnsavedChanges(): boolean {
    return !!(window as any).File?.bundle?.hasModified
  },

  /** Get the #write DOM element (editor area). */
  getWritingArea(): HTMLDivElement | null {
    return getEditor()?.writingArea ?? document.querySelector('#write')
  },

  /** Check if source mode is active. */
  isSourceMode(): boolean {
    return getEditor()?.sourceView?.inSourceMode ?? false
  },

  /** Get the library/sidebar's watched folder. */
  getWatchedFolder(): string | undefined {
    return getEditor()?.library?.watchedFolder
  },

  /** Open a file by path. */
  openFile(filepath: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const lib = getEditor()?.library
      if (lib?.openFile) {
        lib.openFile(filepath, resolve)
      } else {
        resolve()
      }
    })
  },

  /** Insert text at the current cursor position. */
  insertText(text: string): void {
    getEditor()?.insertText(text)
  },

  /**
   * Wait for Typora's editor to be initialized.
   * Polls until File.editor is available (max ~10s).
   */
  waitForEditor(timeout = 10_000): Promise<TyporaEditor> {
    return new Promise((resolve, reject) => {
      const ed = getEditor()
      if (ed) return resolve(ed)

      const start = Date.now()
      const timer = setInterval(() => {
        const ed = getEditor()
        if (ed) {
          clearInterval(timer)
          resolve(ed)
        } else if (Date.now() - start > timeout) {
          clearInterval(timer)
          reject(new Error('[tpl] editor not available after timeout'))
        }
      }, 100)
    })
  },
}
