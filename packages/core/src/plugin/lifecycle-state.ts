import type { Platform } from '../platform/index.js'

interface PersistedPluginLifecycleState {
  version: 1
  enabled: Record<string, boolean>
}

/** Persistent desired plugin state. Missing entries intentionally default to enabled. */
export class PluginLifecycleStateStore {
  private readonly filePath: string
  private enabled = new Map<string, boolean>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly platform: Platform) {
    this.filePath = platform.path.join(platform.dataDir, 'plugin-lifecycle.json')
  }

  async load(): Promise<void> {
    try {
      if (!await this.platform.fs.exists(this.filePath)) return
      const parsed = JSON.parse(await this.platform.fs.readText(this.filePath)) as Partial<PersistedPluginLifecycleState>
      if (!parsed.enabled || typeof parsed.enabled !== 'object') return
      this.enabled = new Map(
        Object.entries(parsed.enabled).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
      )
    } catch (err) {
      console.warn('[tpl:manager] failed to load plugin lifecycle state; using enabled defaults:', err)
      this.enabled.clear()
    }
  }

  isEnabled(id: string): boolean {
    return this.enabled.get(id) ?? true
  }

  setEnabled(id: string, desiredEnabled: boolean): Promise<void> {
    const run = this.writeQueue.catch(() => {}).then(async () => {
      const next = new Map(this.enabled)
      next.set(id, desiredEnabled)
      const snapshot: PersistedPluginLifecycleState = {
        version: 1,
        enabled: Object.fromEntries(next),
      }
      await this.platform.fs.mkdir(this.platform.path.dirname(this.filePath))
      await this.platform.fs.writeText(this.filePath, JSON.stringify(snapshot, null, 2))
      this.enabled = next
    })
    this.writeQueue = run
    return run
  }
}
