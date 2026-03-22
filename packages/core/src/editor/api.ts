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
    if (ed?.getMarkdown) {
      return ed.getMarkdown()
    }
    // Fallback: try nodeMap
    if (ed?.nodeMap?.toMark) {
      return ed.nodeMap.toMark()
    }
    console.warn('[tpl:editor] getMarkdown: no editor or method available', {
      hasFile: !!(window as any).File,
      hasEditor: !!ed,
      editorKeys: ed ? Object.keys(ed).slice(0, 10) : [],
    })
    return ''
  },

  /**
   * Replace the entire document markdown content.
   * Uses File.reloadContent(markdown, skipUndo, delayRefresh, fromDiskChange, skipStore).
   * Signature from typora-community-plugin types.
   */
  setMarkdown(content: string): void {
    const f = (window as any).File
    if (f?.reloadContent) {
      // reloadContent(md, skipUndo=false, delayRefresh=true, fromDiskChange=false, skipStore=true)
      // Match typora-community-plugin's proven call pattern
      f.reloadContent(content, false, true, false, true)
    } else {
      console.warn('[tpl:editor] File.reloadContent not available')
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
