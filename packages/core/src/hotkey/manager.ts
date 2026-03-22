/**
 * Hotkey manager — cross-platform keyboard shortcut registration.
 * Maps "Mod" to Cmd on macOS, Ctrl on Win/Linux.
 */

import { IS_MAC } from '../platform/detect.js'

interface HotkeyBinding {
  key: string
  normalized: string
  callback: () => void
}

/**
 * Normalize a hotkey string like "Mod+Shift+F" into a comparable form.
 * Mod → Meta (macOS) or Ctrl (Win/Linux).
 * All parts lowercased and sorted for consistent matching.
 */
function normalizeHotkey(key: string): string {
  return key
    .split('+')
    .map(part => {
      const p = part.trim().toLowerCase()
      if (p === 'mod') return IS_MAC ? 'meta' : 'ctrl'
      if (p === 'cmd' || p === 'command') return 'meta'
      if (p === 'option') return 'alt'
      return p
    })
    .sort()
    .join('+')
}

/** Build the normalized key from a KeyboardEvent. */
function eventToNormalized(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey) parts.push('meta')
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')

  // Exclude modifier-only keys
  const keyName = e.key.toLowerCase()
  if (!['meta', 'control', 'alt', 'shift'].includes(keyName)) {
    parts.push(keyName)
  }

  return parts.sort().join('+')
}

export class HotkeyManager {
  private bindings = new Map<string, HotkeyBinding>()
  private listening = false

  register(key: string, callback: () => void): void {
    const normalized = normalizeHotkey(key)
    this.bindings.set(normalized, { key, normalized, callback })
    this.ensureListener()
  }

  unregister(key: string): void {
    const normalized = normalizeHotkey(key)
    this.bindings.delete(normalized)
  }

  private ensureListener(): void {
    if (this.listening) return
    this.listening = true
    document.addEventListener('keydown', this.handleKeydown, true)
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    const normalized = eventToNormalized(e)
    const binding = this.bindings.get(normalized)
    if (binding) {
      e.preventDefault()
      e.stopPropagation()
      try {
        binding.callback()
      } catch (err) {
        console.error(`[tpl] hotkey handler error for "${binding.key}":`, err)
      }
    }
  }

  /** Tear down the global listener. */
  destroy(): void {
    document.removeEventListener('keydown', this.handleKeydown, true)
    this.bindings.clear()
    this.listening = false
  }

  /** Get all registered hotkey descriptions. */
  getBindings(): Array<{ key: string; normalized: string }> {
    return [...this.bindings.values()].map(b => ({ key: b.key, normalized: b.normalized }))
  }
}
