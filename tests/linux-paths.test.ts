import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getDataDir, getPluginsDir } from '../packages/core/src/platform/detect.ts'
import {
  getDefaultSettingsPath,
  readLocalSettings,
} from '../clients/node/src/index.ts'

function withWindow<T>(windowStub: Record<string, unknown>, body: () => T): T {
  const original = (globalThis as Record<string, unknown>).window
  ;(globalThis as Record<string, unknown>).window = windowStub
  try {
    return body()
  } finally {
    ;(globalThis as Record<string, unknown>).window = original
  }
}

function withEnv<T>(
  patch: { platform?: NodeJS.Platform; home?: string },
  body: () => T | Promise<T>,
): Promise<T> {
  return (async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const originalHome = process.env.HOME
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    const originalAppData = process.env.APPDATA

    if (patch.platform) {
      Object.defineProperty(process, 'platform', { value: patch.platform })
    }
    if (patch.home !== undefined) {
      process.env.HOME = patch.home
      delete process.env.XDG_CONFIG_HOME
      delete process.env.APPDATA
    }

    try {
      return await body()
    } finally {
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
      if (originalAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = originalAppData
    }
  })()
}

const linuxWindow = (home: string, userPath: string) => ({
  reqnode: (name: string) => {
    if (name === 'os') return { homedir: () => home }
    if (name === 'path') return { join }
    throw new Error(`Unexpected module request: ${name}`)
  },
  process: { platform: 'linux' },
  _options: { userPath },
})

test('linux runtime dataDir lives under ~/.local/Typora/data regardless of userPath', () => {
  withWindow(linuxWindow('/home/tester', '/home/tester'), () => {
    assert.equal(getDataDir(), '/home/tester/.local/Typora/data')
  })
  withWindow(linuxWindow('/home/tester', '/tmp/something-else'), () => {
    assert.equal(getDataDir(), '/home/tester/.local/Typora/data')
  })
})

test('linux runtime pluginsDir lives under ~/.local/Typora/plugins regardless of userPath', () => {
  withWindow(linuxWindow('/home/tester', '/home/tester'), () => {
    assert.equal(getPluginsDir(), '/home/tester/.local/Typora/plugins')
  })
  withWindow(linuxWindow('/home/tester', '/opt/foo'), () => {
    assert.equal(getPluginsDir(), '/home/tester/.local/Typora/plugins')
  })
})

test('linux node client default settings path is pinned to ~/.local/Typora/data', async () => {
  await withEnv({ platform: 'linux', home: '/home/tester' }, () => {
    assert.equal(
      getDefaultSettingsPath(),
      '/home/tester/.local/Typora/data/remote-control/settings.json',
    )
  })
})

test('darwin node client default settings path still uses ~/Library/Application Support', async () => {
  await withEnv({ platform: 'darwin', home: '/Users/tester' }, () => {
    assert.equal(
      getDefaultSettingsPath(),
      '/Users/tester/Library/Application Support/abnerworks.Typora/plugins/data/remote-control/settings.json',
    )
  })
})

test('windows node client default settings path still uses %APPDATA%/Typora', async () => {
  await withEnv({ platform: 'win32', home: 'C:\\Users\\tester' }, () => {
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    assert.equal(
      getDefaultSettingsPath(),
      join('C:\\Users\\tester\\AppData\\Roaming', 'Typora', 'plugins', 'data', 'remote-control', 'settings.json'),
    )
  })
})

test('linux node client throws ENOENT when settings missing (no legacy fallback)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tpl-home-'))
  try {
    await withEnv({ platform: 'linux', home }, async () => {
      // Pre-seed the legacy ~/plugins/data location — it MUST be ignored.
      const legacyDir = join(home, 'plugins', 'data', 'remote-control')
      await mkdir(legacyDir, { recursive: true })
      await writeFile(
        join(legacyDir, 'settings.json'),
        JSON.stringify({ host: '127.0.0.1', port: 5619, token: 'legacy-should-be-ignored' }),
        'utf8',
      )

      await assert.rejects(
        () => readLocalSettings(),
        (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
      )
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('linux node client reads settings from the new ~/.local/Typora/data path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tpl-home-'))
  try {
    await withEnv({ platform: 'linux', home }, async () => {
      const settingsDir = join(home, '.local', 'Typora', 'data', 'remote-control')
      await mkdir(settingsDir, { recursive: true })
      await writeFile(
        join(settingsDir, 'settings.json'),
        JSON.stringify({ host: '127.0.0.1', port: 5619, token: 'new-token' }),
        'utf8',
      )

      const settings = await readLocalSettings()
      assert.deepEqual(settings, { host: '127.0.0.1', port: 5619, token: 'new-token' })
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
