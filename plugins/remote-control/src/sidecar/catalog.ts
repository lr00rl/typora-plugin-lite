/**
 * Machine-readable catalog of every RPC method the sidecar exposes.
 *
 * Without this, a client (or an AI agent driving Typora) has to know the method
 * names, their params, and — critically — *why* a call might 403 or 503 out of
 * band. `system.listMethods` turns that tribal knowledge into an introspection
 * call: names, one-line descriptions, param hints, the authorization tier each
 * method sits in, and whether it is reachable *right now* given the sidecar's
 * current policy and whether Typora is connected.
 *
 * Keeping the catalog as data (rather than deriving it from the live handler
 * map) is deliberate: the gate that decides availability lives here too, so a
 * single unit test can assert that flipping allowExec / allowEval / the Typora
 * session flips exactly the methods it should — no live server required.
 */

/**
 * Authorization tiers, mirroring README's L0–L3 matrix.
 *   open   — pre-auth entry point
 *   auth   — any authenticated session
 *   typora — auth + a connected Typora session (else 503)
 *   exec   — auth + allowExec=true (else 403)
 *   eval   — auth + a Typora session + allowEval=true (else 403/503)
 */
export type MethodTier = 'open' | 'auth' | 'typora' | 'exec' | 'eval'

export interface MethodSpec {
  name: string
  tier: MethodTier
  summary: string
  params?: string
}

export interface CatalogState {
  allowExec: boolean
  allowEval: boolean
  typoraConnected: boolean
}

export interface MethodInfo extends MethodSpec {
  /** Reachable right now given policy + Typora presence. */
  available: boolean
  /** When unavailable, the reason a call would fail; null when available. */
  unavailableReason: string | null
}

export const METHOD_SPECS: readonly MethodSpec[] = [
  { name: 'session.authenticate', tier: 'open', summary: 'Authenticate a session with the bearer token.', params: '{ token, role?: "client" | "typora" }' },
  { name: 'system.ping', tier: 'auth', summary: 'Liveness probe. Returns "pong".' },
  { name: 'system.getInfo', tier: 'auth', summary: 'Sidecar pid, bound host/port, session and exec counts, Typora connectivity.' },
  { name: 'system.listMethods', tier: 'auth', summary: 'This catalog: every method, its tier, and whether it is reachable now.' },
  { name: 'system.shutdown', tier: 'auth', summary: 'Ask the sidecar to exit. Any authenticated session may call this.' },

  { name: 'exec.run', tier: 'exec', summary: 'Run a shell command, buffered; returns exit code, stdout, stderr.', params: '{ command, cwd?, timeoutMs?, maxBytes? }' },
  { name: 'exec.start', tier: 'exec', summary: 'Spawn a long-running command; stdout/stderr/exit stream as notifications.', params: '{ command, cwd? }' },
  { name: 'exec.kill', tier: 'exec', summary: 'Signal a running exec.start child.', params: '{ execId, signal? }' },
  { name: 'exec.list', tier: 'exec', summary: 'List live exec.start children.' },

  { name: 'typora.getContext', tier: 'typora', summary: 'Current file path/name, mount + watched folder, source mode, dirty flag, commands.' },
  { name: 'typora.getDocument', tier: 'typora', summary: 'Current file path/name and full markdown (wrapped in trust-boundary markers).' },
  { name: 'typora.setDocument', tier: 'typora', summary: 'Replace the whole document markdown.', params: '{ markdown }' },
  { name: 'typora.getSelection', tier: 'typora', summary: 'The text the user currently has selected, and whether a selection exists.' },
  { name: 'typora.insertText', tier: 'typora', summary: 'Insert text at the cursor.', params: '{ text }' },
  { name: 'typora.setSourceMode', tier: 'typora', summary: 'Toggle source (raw markdown) mode.', params: '{ enabled }' },
  { name: 'typora.openFile', tier: 'typora', summary: 'Open a file by absolute path.', params: '{ filePath }' },
  { name: 'typora.openFolder', tier: 'typora', summary: 'Switch the workspace to a folder.', params: '{ folderPath }' },
  { name: 'typora.commands.list', tier: 'typora', summary: 'List all registered app commands.' },
  { name: 'typora.commands.invoke', tier: 'typora', summary: 'Invoke an app command by id.', params: '{ commandId }' },
  { name: 'typora.plugins.list', tier: 'typora', summary: 'List installed plugins and their loaded state.' },
  { name: 'typora.plugins.setEnabled', tier: 'typora', summary: 'Enable or disable a plugin.', params: '{ pluginId, enabled }' },
  { name: 'typora.plugins.commands.list', tier: 'typora', summary: 'List commands, optionally filtered to one plugin.', params: '{ pluginId? }' },
  { name: 'typora.plugins.commands.invoke', tier: 'typora', summary: 'Invoke a command, asserting it belongs to a plugin.', params: '{ pluginId, commandId }' },

  { name: 'typora.eval', tier: 'eval', summary: 'Run arbitrary JavaScript in the Typora renderer. Requires allowEval=true.', params: '{ code, async?, timeoutMs? }' },
]

function reasonFor(tier: MethodTier, state: CatalogState): string | null {
  switch (tier) {
    case 'open':
    case 'auth':
      return null
    case 'typora':
      return state.typoraConnected ? null : '503: Typora session is unavailable'
    case 'exec':
      return state.allowExec ? null : '403: exec disabled by server policy (allowExec=false)'
    case 'eval':
      if (!state.allowEval) return '403: typora.eval disabled by server policy (allowEval=false)'
      if (!state.typoraConnected) return '503: Typora session is unavailable'
      return null
  }
}

/** Resolve each spec against the current policy/connectivity state. */
export function buildMethodCatalog(state: CatalogState): MethodInfo[] {
  return METHOD_SPECS.map(spec => {
    const unavailableReason = reasonFor(spec.tier, state)
    return { ...spec, available: unavailableReason === null, unavailableReason }
  })
}
