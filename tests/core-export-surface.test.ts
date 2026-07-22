import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The plugin runtime reads core through TWO surfaces that must stay in sync:
 *
 *   1. the ES module exports of packages/core/src/index.ts (what tsc checks
 *      when a plugin writes `import { x } from '@typora-plugin-lite/core'`)
 *   2. the hand-written `coreExports` object assigned to window.__tpl.core
 *      (what the built shim actually hands to the plugin at runtime)
 *
 * scripts/build.ts generates the shim from (2), so a name missing from (2) is
 * an `undefined is not a function` crash inside Typora that neither tsc nor
 * the build catches. This test locks the two surfaces together.
 */

const INDEX = join(dirname(fileURLToPath(import.meta.url)), '../packages/core/src/index.ts')

function coreExportsKeys(src: string): string[] {
  const match = src.match(/const coreExports = \{([^}]*)\}/s)
  assert.ok(match, 'coreExports object not found in core index.ts')
  return match[1]!
    .split(',')
    .map(part => part.trim())
    .filter(part => /^[A-Za-z_$][\w$]*$/.test(part))
}

test('every coreExports key is also a module-level export', () => {
  const src = readFileSync(INDEX, 'utf8')
  const keys = coreExportsKeys(src)
  assert.ok(keys.length > 10, `suspiciously few coreExports keys: ${keys.length}`)

  // Collect the module's exported names from `export { ... }` blocks
  // (including `export { ... } from '...'` re-exports).
  const exported = new Set<string>()
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exported.add(name)
    }
  }
  // ... and from `export function/const/class` declarations.
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|class|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    exported.add(m[1]!)
  }

  const missing = keys.filter(key => !exported.has(key))
  assert.deepEqual(missing, [], `coreExports keys not exported at module level: ${missing.join(', ')}`)
})

test('the codeblock helpers added for code-viewer/fence-enhance are exposed', () => {
  const src = readFileSync(INDEX, 'utf8')
  const keys = coreExportsKeys(src)
  for (const name of [
    'splitWhitespace',
    'indentColumns',
    'indentGuideColumns',
    'indentGuideBackground',
    'CODEBLOCK_MARKER_CSS',
    'detectIndentUnit',
    'guideColumnsPerLine',
  ]) {
    assert.ok(keys.includes(name), `${name} missing from coreExports`)
  }
})
