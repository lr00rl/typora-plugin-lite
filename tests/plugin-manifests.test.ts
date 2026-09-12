import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = join(root, 'plugins')

function builtPluginNames(): string[] {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'src', 'main.ts')))
    .map(entry => entry.name)
}

test('every built plugin has a valid manifest.json whose id matches the folder', () => {
  const names = builtPluginNames()
  assert.ok(names.length > 0, 'expected at least one plugin')
  for (const name of names) {
    const manifestPath = join(pluginsDir, name, 'manifest.json')
    assert.ok(existsSync(manifestPath), `${name} is missing manifest.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      id?: string
      name?: string
      version?: string
      loading?: unknown
    }
    assert.equal(manifest.id, name)
    assert.equal(typeof manifest.name, 'string')
    assert.ok(manifest.name)
    assert.equal(typeof manifest.version, 'string')
    assert.ok(manifest.loading && typeof manifest.loading === 'object')
  }
})
