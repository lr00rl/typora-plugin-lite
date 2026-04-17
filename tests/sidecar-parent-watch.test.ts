import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import {
  watchParentOrExit,
  gracefulShutdown,
} from '../plugins/remote-control/src/sidecar/server.ts'

function sleep(ms: number): Promise<void> {
  // Don't unref — tests need the event loop to stay alive until the timer
  // fires, otherwise Node's test runner cancels them with
  // "Promise resolution is still pending but the event loop has already resolved".
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

test('watchParentOrExit: skips watcher when pid is 0 or init', () => {
  let fired = 0
  const cancelZero = watchParentOrExit(0, () => { fired++ }, 5)
  const cancelInit = watchParentOrExit(1, () => { fired++ }, 5)
  assert.equal(fired, 0)
  cancelZero()
  cancelInit()
})

test('watchParentOrExit: does NOT fire while parent is alive', async () => {
  let fired = 0
  const cancel = watchParentOrExit(process.pid, () => { fired++ }, 20)
  await sleep(80)
  cancel()
  assert.equal(fired, 0, 'watcher must not trigger on a live pid')
})

test('watchParentOrExit: fires exactly once when parent disappears', async () => {
  // Spawn a sleeping child, grab its pid, then kill it — watcher should
  // observe ESRCH and invoke onDead exactly once even if interval keeps ticking.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    stdio: 'ignore',
  })
  await sleep(30) // let it settle

  let fired = 0
  let cancel = () => {}
  try {
    cancel = watchParentOrExit(child.pid!, () => { fired++ }, 20)
    child.kill('SIGKILL')
    // Give the watcher up to ~300ms to observe the death across 15 interval ticks.
    for (let i = 0; i < 15 && fired === 0; i++) await sleep(20)
    assert.equal(fired, 1, 'onDead should fire exactly once')

    // Confirm no double-fire even if we keep waiting.
    await sleep(80)
    assert.equal(fired, 1, 'onDead should not re-fire')
  } finally {
    cancel()
    try { child.kill('SIGKILL') } catch {}
  }
})

test('gracefulShutdown: closes cleanly and exits 0', async () => {
  const exitCodes: number[] = []
  let closed = false

  await gracefulShutdown(
    async () => { closed = true },
    {
      timeoutMs: 1000,
      exit: (code) => { exitCodes.push(code) },
    },
  )

  assert.equal(closed, true)
  assert.deepEqual(exitCodes, [0])
})

test('gracefulShutdown: exits 1 when close() throws', async () => {
  const exitCodes: number[] = []

  await gracefulShutdown(
    async () => { throw new Error('close blew up') },
    {
      timeoutMs: 1000,
      exit: (code) => { exitCodes.push(code) },
    },
  )

  assert.deepEqual(exitCodes, [1])
})

test('gracefulShutdown: hard-timeout fires exit(1) when close() hangs, no double-exit when close eventually settles', async () => {
  const exitCodes: number[] = []

  // Controllable close() — the test resolves it AFTER the hard timeout has
  // already fired, to prove the double-exit guard works.
  let closeResolve!: () => void
  const closePromise = new Promise<void>((resolve) => {
    closeResolve = resolve
  })

  const shutdownPromise = gracefulShutdown(
    () => closePromise,
    {
      timeoutMs: 30,
      exit: (code) => { exitCodes.push(code) },
    },
  )

  // Let the hard timeout fire first.
  await sleep(80)
  assert.deepEqual(exitCodes, [1], 'hard timeout must trigger exit(1)')

  // Now let close() resolve late. gracefulShutdown must NOT call exit again.
  closeResolve()
  await shutdownPromise
  assert.deepEqual(exitCodes, [1], 'late close() resolution must not double-exit')
})
