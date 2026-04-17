/**
 * Per-plugin JSON-backed settings.
 * Stored at <dataDir>/<pluginId>/settings.json
 * (dataDir is platform-specific and survives Typora updates)
 */

import type { Platform } from '../platform/index.js'

export type SettingsChangeHandler<T extends Record<string, unknown>> =
  (key: keyof T, value: T[keyof T], previous: T[keyof T]) => void

export class PluginSettings<T extends Record<string, unknown> = Record<string, unknown>> {
  private data: T
  private filePath: string
  private changeHandlers: Set<SettingsChangeHandler<T>> = new Set()

  constructor(
    private pluginId: string,
    private defaults: T,
    private platform: Platform,
  ) {
    this.data = { ...defaults }
    this.filePath = platform.path.join(
      platform.dataDir, pluginId, 'settings.json',
    )
  }

  async load(): Promise<void> {
    try {
      const exists = await this.platform.fs.exists(this.filePath)
      if (!exists) return

      const text = await this.platform.fs.readText(this.filePath)
      const parsed = JSON.parse(text)
      this.data = { ...this.defaults, ...parsed }
    } catch (err) {
      console.warn(
        `[tpl:settings] failed to load settings for "${this.pluginId}" from ${this.filePath}, falling back to defaults:`,
        err,
      )
      this.data = { ...this.defaults }
    }
  }

  async save(): Promise<void> {
    const dir = this.platform.path.dirname(this.filePath)
    await this.platform.fs.mkdir(dir)
    await this.platform.fs.writeText(this.filePath, JSON.stringify(this.data, null, 2))
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.data[key]
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    const previous = this.data[key]
    this.data[key] = value
    if (Object.is(previous, value)) return
    // Snapshot handlers so a subscriber that unsubscribes during dispatch
    // doesn't mutate the iteration.
    const handlers = [...this.changeHandlers]
    for (const fn of handlers) {
      try {
        fn(key, value, previous)
      } catch (err) {
        console.error(`[tpl:settings] change handler for "${this.pluginId}.${String(key)}" threw:`, err)
      }
    }
  }

  /**
   * Subscribe to settings changes. Handler fires AFTER `set()` has updated
   * internal state but BEFORE `save()` is called (save is always caller-driven).
   * Returns an unsubscribe function. Exceptions inside the handler are logged
   * and swallowed so one broken subscriber can't break others.
   */
  onChange(handler: SettingsChangeHandler<T>): () => void {
    this.changeHandlers.add(handler)
    return () => { this.changeHandlers.delete(handler) }
  }

  getAll(): Readonly<T> {
    return structuredClone(this.data)
  }
}
