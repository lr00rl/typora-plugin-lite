import test from 'node:test'
import assert from 'node:assert/strict'

import { EventBus } from '../packages/core/src/plugin/events.ts'
import { CommandRegistry } from '../packages/core/src/command/registry.ts'

test('tracks command registrations from the event bus and executes callbacks', async () => {
  const events = new EventBus()
  const registry = new CommandRegistry(events)
  let called = 0

  events.emit('command:register', {
    id: 'demo.alpha',
    name: 'Alpha',
    pluginId: 'demo',
    callback: async () => {
      called += 1
      return 'ok'
    },
  })

  assert.deepEqual(registry.list(), [
    {
      id: 'demo.alpha',
      name: 'Alpha',
      pluginId: 'demo',
    },
  ])

  const result = await registry.execute('demo.alpha')
  assert.equal(result, 'ok')
  assert.equal(called, 1)
})

test('removes commands when the event bus unregisters them', () => {
  const events = new EventBus()
  const registry = new CommandRegistry(events)

  events.emit('command:register', {
    id: 'demo.alpha',
    name: 'Alpha',
    pluginId: 'demo',
    callback: () => 'ok',
  })
  events.emit('command:unregister', 'demo.alpha')

  assert.deepEqual(registry.list(), [])
})

test('throws a stable error when executing a missing command', async () => {
  const events = new EventBus()
  const registry = new CommandRegistry(events)

  await assert.rejects(
    () => registry.execute('missing.command'),
    /Unknown command: missing\.command/,
  )
})
