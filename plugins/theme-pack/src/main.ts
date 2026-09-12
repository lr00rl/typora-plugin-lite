import {
  Plugin,
  getHomedir,
  IS_MAC,
  IS_NODE,
  platform,
  type SettingsSchema,
} from '@typora-plugin-lite/core'

import { reloadManagedThemeIfActive, refreshTyporaThemeCatalog } from './activate.js'
import { createHttpClient } from './http.js'
import { joinPath, resolveThemesDir } from './paths.js'
import { nextState, packUpdated, syncThemePack, type PackState, type SyncResult } from './sync.js'
import {
  DEFAULT_THEME_REF,
  DEFAULT_THEME_SOURCE,
  parseThemeSource,
} from './source.js'

interface ThemePackSettings extends Record<string, unknown> {
  source: string
  ref: string
  checkOnStartup: boolean
}

const DEFAULT_SETTINGS: ThemePackSettings = {
  source: DEFAULT_THEME_SOURCE,
  ref: DEFAULT_THEME_REF,
  checkOnStartup: true,
}

export default class ThemePackPlugin extends Plugin<ThemePackSettings> {
  static settingsSchema: SettingsSchema<ThemePackSettings> = {
    fields: {
      source: {
        kind: 'string',
        label: 'Theme source',
        description: 'GitHub repository that ships theme-pack.json (typ: typora-plugin-lite-theme-pack). Built-in Typora themes stay selectable.',
        placeholder: DEFAULT_THEME_SOURCE,
        monospace: true,
        validate: (value) => {
          try {
            parseThemeSource(value, { homedir: '/', ref: DEFAULT_THEME_REF })
            return null
          } catch (err) {
            return err instanceof Error ? err.message : 'invalid source'
          }
        },
      },
      ref: {
        kind: 'string',
        label: 'Git ref',
        description: 'Branch, tag, or commit. Ignored for a local folder used while developing a pack.',
        placeholder: DEFAULT_THEME_REF,
        monospace: true,
      },
      checkOnStartup: {
        kind: 'toggle',
        label: 'Check on startup',
        description: 'Refresh from GitHub when Typora starts. Unchanged files are left alone. The current theme is never switched.',
      },
    },
  }

  static defaultSettings: ThemePackSettings = { ...DEFAULT_SETTINGS }

  private syncing = false

  async onload(): Promise<void> {
    this.registerCommand({
      id: 'theme-pack:sync',
      name: 'Theme Pack: Sync now',
      callback: () => { void this.sync({ notify: true }) },
    })
    this.addDisposable(this.settings.onChange((key) => {
      if (key === 'source' || key === 'ref') void this.sync({ notify: true })
    }))
    if (this.settings.get('checkOnStartup') !== false) {
      await this.sync({ notify: false })
    }
  }

  private async sync(opts: { notify: boolean }): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      const sourceLabel = (this.settings.get('source') || DEFAULT_THEME_SOURCE).trim()
      const ref = (this.settings.get('ref') || DEFAULT_THEME_REF).trim()
      const homedir = getHomedir()
      const source = parseThemeSource(sourceLabel, { ref, homedir })
      const themesDir = this.themesDir(homedir)
      const previous = await this.loadState()
      const tmpDir = joinPath(platform.dataDir, 'theme-pack', 'tmp')
      if (source.kind !== 'local') {
        try { await platform.fs.remove(tmpDir) } catch {}
      }
      const http = source.kind === 'local'
        ? undefined
        : createHttpClient({
          preferNode: IS_NODE,
          reqnode: window.reqnode,
          shell: platform.shell,
          fs: platform.fs,
          tmpDir,
          cwd: homedir || themesDir,
        })
      const result = await syncThemePack(source, themesDir, {
        fs: platform.fs,
        http,
        join: IS_NODE ? (...parts: string[]) => platform.path.join(...parts) : joinPath,
        isSymlink: (path) => this.isSymlink(path),
      }, previous)
      await this.saveState(nextState(sourceLabel, ref, result))
      this.applyHostAfterSync(result)
      if (opts.notify) {
        this.showNotice(summarize(result), 2500)
      } else if (packUpdated(result)) {
        this.showNotice(`Theme pack updated (${result.pack.name})`, 2200)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[tpl:theme-pack]', message)
      if (opts.notify) this.showNotice(message, 4000)
    } finally {
      this.syncing = false
    }
  }

  private applyHostAfterSync(result: SyncResult): void {
    const destNames = result.files.map(file => file.destName)
    reloadManagedThemeIfActive(document, destNames)
    if (packUpdated(result)) {
      refreshTyporaThemeCatalog({
        JSBridge: window.JSBridge,
        bridge: window.bridge as { callHandler?: (name: string, payload?: unknown) => void } | undefined,
      })
    }
  }

  private themesDir(homedir: string): string {
    const options = (window as unknown as {
      _options?: {
        userPath?: string
        currentThemeFolder?: string
        userDataPath?: string
      }
    })._options
    const processInfo = (window as unknown as {
      process?: { platform?: string; env?: { APPDATA?: string } }
    }).process
    return resolveThemesDir({
      isMac: IS_MAC,
      homedir,
      userPath: options?.userPath,
      currentThemeFolder: options?.currentThemeFolder,
      userDataPath: options?.userDataPath,
      nodePlatform: processInfo?.platform,
      appData: processInfo?.env?.APPDATA,
    })
  }

  private statePath(): string {
    return joinPath(platform.dataDir, 'theme-pack', 'state.json')
  }

  private async loadState(): Promise<PackState | null> {
    const path = this.statePath()
    try {
      if (!await platform.fs.exists(path)) return null
      return JSON.parse(await platform.fs.readText(path)) as PackState
    } catch (err) {
      console.warn('[tpl:theme-pack] could not read state.json', err)
      return null
    }
  }

  private async saveState(state: PackState): Promise<void> {
    const path = this.statePath()
    await platform.fs.mkdir(joinPath(platform.dataDir, 'theme-pack'))
    await platform.fs.writeText(path, `${JSON.stringify(state, null, 2)}\n`)
  }

  private async isSymlink(path: string): Promise<boolean> {
    if (!await platform.fs.exists(path)) return false
    if (IS_NODE) {
      try {
        const fs = window.reqnode?.('fs')
        if (fs?.lstatSync) return fs.lstatSync(path).isSymbolicLink()
      } catch {}
      return false
    }
    try {
      const out = (await platform.shell.run(
        `if [ -L ${platform.shell.escape(path)} ]; then echo 1; else echo 0; fi`,
        { timeout: 3000 },
      )).trim()
      return out === '1'
    } catch {
      return false
    }
  }
}

function summarize(result: SyncResult): string {
  const written = result.files.filter(file => file.action === 'written').length
  const linked = result.files.filter(file => file.action === 'symlink').length
  if (written) return `Updated ${written} theme file${written === 1 ? '' : 's'}`
  if (linked) return 'Theme files are local symlinks; left in place'
  return 'Theme pack already up to date'
}
