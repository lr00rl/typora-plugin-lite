/**
 * Simple event bus for inter-plugin communication and internal events.
 */

type Handler = (...args: any[]) => void

export class EventBus {
  private listeners = new Map<string, Set<Handler>>()

  on(event: string, handler: Handler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
  }

  off(event: string, handler: Handler): void {
    this.listeners.get(event)?.delete(handler)
  }

  emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach(handler => {
      try {
        handler(...args)
      } catch (err) {
        console.error(`[tpl] event handler error for "${event}":`, err)
      }
    })
  }

  once(event: string, handler: Handler): void {
    const wrapped = (...args: any[]) => {
      this.off(event, wrapped)
      handler(...args)
    }
    this.on(event, wrapped)
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event)
    } else {
      this.listeners.clear()
    }
  }
}
