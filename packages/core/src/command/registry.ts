import type { EventBus } from '../plugin/events.js'
import type { Command } from '../plugin/plugin.js'

export interface CommandSummary {
  id: string
  name: string
  pluginId: string | null
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()
  private readonly offRegister?: () => void
  private readonly offUnregister?: () => void

  constructor(events?: EventBus) {
    if (!events) return

    const onRegister = (command: Command) => {
      this.register(command)
    }
    const onUnregister = (id: string) => {
      this.unregister(id)
    }

    events.on('command:register', onRegister)
    events.on('command:unregister', onUnregister)

    this.offRegister = () => events.off('command:register', onRegister)
    this.offUnregister = () => events.off('command:unregister', onUnregister)
  }

  register(command: Command): void {
    if (!command?.id || !command?.name || typeof command.callback !== 'function') {
      throw new Error('Invalid command registration')
    }
    this.commands.set(command.id, command)
  }

  unregister(id: string): void {
    this.commands.delete(id)
  }

  list(): CommandSummary[] {
    return [...this.commands.values()]
      .map(command => ({
        id: command.id,
        name: command.name,
        pluginId: command.pluginId ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  async execute(id: string): Promise<unknown> {
    const command = this.commands.get(id)
    if (!command) {
      throw new Error(`Unknown command: ${id}`)
    }
    return await command.callback()
  }

  destroy(): void {
    this.offRegister?.()
    this.offUnregister?.()
    this.commands.clear()
  }
}
