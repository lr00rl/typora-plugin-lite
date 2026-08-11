import test from 'node:test'
import assert from 'node:assert/strict'

import { PluginSettings } from '../packages/core/src/plugin/settings.ts'

test('serializes settings snapshots so an older write cannot finish last', async () => {
  const writes: string[] = []
  let releaseFirstWrite!: () => void
  const firstWrite = new Promise<void>(resolve => { releaseFirstWrite = resolve })
  let startedWrites = 0
  const platform = {
    dataDir: '/data',
    path: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (path: string) => path.slice(0, path.lastIndexOf('/')),
    },
    fs: {
      exists: async () => false,
      readText: async () => '',
      mkdir: async () => {},
      writeText: async (_path: string, text: string) => {
        startedWrites += 1
        if (startedWrites === 1) await firstWrite
        writes.push(text)
      },
    },
  }
  const settings = new PluginSettings(
    'test-plugin',
    { host: 'localhost', port: 1 },
    platform as never,
  )

  settings.set('host', 'first.example')
  const firstSave = settings.save()
  await new Promise(resolve => setTimeout(resolve, 0))
  settings.set('port', 2)
  const secondSave = settings.save()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(startedWrites, 1, 'the second filesystem write must wait for the first')
  releaseFirstWrite()
  await Promise.all([firstSave, secondSave])

  assert.equal(writes.length, 2)
  assert.deepEqual(JSON.parse(writes[0]!), { host: 'first.example', port: 1 })
  assert.deepEqual(JSON.parse(writes[1]!), { host: 'first.example', port: 2 })
})
