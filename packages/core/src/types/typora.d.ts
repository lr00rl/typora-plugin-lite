/**
 * Typora global environment type declarations.
 * Based on typora-copilot's type analysis + typora-community-plugin patterns.
 */

declare var _options: {
  appLocale?: string
  appVersion: string
  userLocale?: string
  userPath: string
}

interface FileConstructorExtensions {
  editor?: TyporaEditor
  bundle?: {
    fileName?: string
    filePath: string
    modifiedDate: Date | number
    hasModified?: string
    savedContent: string
    untitledId: number
    fileEncode?: string
  }
  filePath?: string
  useCRLF?: boolean
  option: { headingStyle: number }
  reloadContent: (
    value: string,
    skipUndo?: boolean,
    delayRefresh?: boolean,
    fromDiskChange?: boolean,
    skipStore?: boolean,
  ) => void
  isLinux: boolean
  isMac: boolean
  isMacNode: boolean
  isNode: boolean
  isWin: boolean
  isWK: boolean
  isSafari: boolean
}

interface TyporaEditor {
  focusCid: string
  writingArea: HTMLDivElement
  library?: {
    root?: TyporaFileEntity
    watchedFolder?: string
    openFile(pathname: string, cb: () => void): void
    fileTree?: {
      expandNode?: ($el: unknown, filepath: string, callback: Function) => void
    }
  }
  nodeMap: {
    allNodes: TyporaNodeMap
    toMark(): string
  }
  sourceView: {
    cm: CodeMirrorLike | null
    inSourceMode: boolean
    prep?: () => void
    show?: () => void
    hide?: () => void
  }
  selection: {
    getRangy: () => unknown
    jumpIntoElemBegin: (elem: unknown) => void
    jumpIntoElemEnd: (elem: unknown) => void
  }
  undo: { undo(): void; redo(): void }
  fences: { getCm(cid: string): CodeMirrorLike }
  getMarkdown: () => string
  getNode: (cid: string) => unknown
  findElemById: (cid: string) => unknown
  insertText: (text: string) => void
  refocus(): void
  restoreLastCursor: () => void
  EditHelper: {
    showDialog: (options: {
      title: string
      message?: string
      html?: string
      buttons: readonly string[]
      type?: 'info' | 'warning' | 'error'
      callback?: (index: number) => void
    }) => void
  }
}

interface TyporaFileEntity {
  createDate: Date
  lastModified: Date
  fetched?: boolean
  isDirectory: boolean
  isFile: boolean
  name: string
  path: string
  content: readonly TyporaFileEntity[]
  subdir: readonly TyporaFileEntity[]
}

interface TyporaNodeMap {
  _map: Map<string, unknown>
  length: number
  forEach: (callback: (node: unknown, index: number) => void) => void
  toArray(): readonly unknown[]
}

interface CodeMirrorLike {
  getValue(): string
  setValue(value: string): void
  getCursor(): { line: number; ch: number }
  setCursor(pos: { line: number; ch: number }): void
}

interface Window {
  reqnode?: {
    (moduleName: 'child_process'): typeof import('node:child_process')
    (moduleName: 'fs'): typeof import('node:fs')
    (moduleName: 'path'): typeof import('node:path')
    (moduleName: string): unknown
  }
  bridge?: {
    callHandler(type: 'library.fetchAllDocs', folder: string): void
    callHandler(type: 'library.listDocsUnder', folder: string, cb: (file: unknown) => void): void
    callHandler(
      type: 'controller.runCommand',
      options: { args: string; cwd?: string },
      cb: (results: [boolean, string, string, string]) => void,
    ): void
    callSync(type: 'path.readText', path: string): string
  }
  File: typeof globalThis.File & FileConstructorExtensions
}
