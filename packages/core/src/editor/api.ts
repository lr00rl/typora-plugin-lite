/**
 * Editor API — thin wrapper around Typora's editor globals.
 * Provides getMarkdown, setMarkdown, waitForEditor utilities.
 */

function getEditor(): TyporaEditor | undefined {
  return (window as any).File?.editor
}

function getSourceView() {
  return getEditor()?.sourceView
}

function getJsBridge() {
  return (window as { JSBridge?: { invoke(method: string, ...args: unknown[]): Promise<unknown> } }).JSBridge
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
    const f = window.File
    if (f?.reloadContent) {
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
    return getSourceView()?.inSourceMode ?? false
  },

  /** Set source mode on or off. Resolves with the resulting state. */
  async setSourceMode(enabled: boolean, timeout = 5_000): Promise<boolean> {
    const sourceView = getSourceView()
    if (!sourceView) {
      throw new Error('[tpl:editor] sourceView not available')
    }

    if (sourceView.inSourceMode === enabled) {
      return sourceView.inSourceMode
    }

    if (enabled) {
      if (!sourceView.cm) {
        sourceView.prep?.()
      }
      if (typeof sourceView.show !== 'function') {
        throw new Error('[tpl:editor] sourceView.show not available')
      }
      sourceView.show()
    } else {
      if (typeof sourceView.hide !== 'function') {
        throw new Error('[tpl:editor] sourceView.hide not available')
      }
      sourceView.hide()
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < timeout) {
      if ((getSourceView()?.inSourceMode ?? false) === enabled) {
        return enabled
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    throw new Error(`[tpl:editor] source mode did not switch to ${enabled ? 'on' : 'off'} before timeout`)
  },

  /** Get the library/sidebar's watched folder. */
  getWatchedFolder(): string | undefined {
    return getEditor()?.library?.watchedFolder
  },

  /** Get Typora's current mount/root folder if available. */
  getMountFolder(): string {
    return window.File?.getMountFolder?.() ?? ''
  },

  /** Open a file by path. Times out after 10s if callback not invoked. */
  openFile(filepath: string, timeout = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const lib = getEditor()?.library
      if (!lib?.openFile) {
        reject(new Error('[tpl:editor] library.openFile not available'))
        return
      }
      const timer = setTimeout(() => {
        reject(new Error(`[tpl:editor] openFile timed out for: ${filepath}`))
      }, timeout)
      lib.openFile(filepath, () => {
        clearTimeout(timer)
        resolve()
      })
    })
  },

  /** Switch Typora to a different folder root. */
  async openFolder(folderPath: string): Promise<void> {
    const bridge = getJsBridge()
    if (!bridge?.invoke) {
      throw new Error('[tpl:editor] JSBridge.invoke not available')
    }
    await bridge.invoke('controller.switchFolder', folderPath)
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
