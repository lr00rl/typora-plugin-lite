/**
 * Per-plugin JSON-backed settings.
 * Stored at <dataDir>/<pluginId>/settings.json
 * (dataDir is in ~/Library/... so it survives Typora updates)
 */

import type { Platform } from '../platform/index.js'

export class PluginSettings<T extends Record<string, unknown> = Record<string, unknown>> {
  private data: T
  private filePath: string

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
      if (exists) {
        const text = await this.platform.fs.readText(this.filePath)
        const parsed = JSON.parse(text)
        this.data = { ...this.defaults, ...parsed }
      }
    } catch {
      // Use defaults on any error
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
    this.data[key] = value
  }

  getAll(): Readonly<T> {
    return this.data
  }
}
