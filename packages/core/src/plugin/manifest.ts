/**
 * Plugin manifest schema — declared in each plugin's manifest.json.
 */

export interface LoadingStrategy {
  /** Load immediately on startup */
  startup?: boolean
  /** Load on first matching event */
  event?: string[]
  /** Load on command palette invocation */
  command?: string[]
  /** Load on first keypress of hotkey */
  hotkey?: string[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** Relative path to main module (default: "main.js") */
  main?: string
  loading: LoadingStrategy
}
