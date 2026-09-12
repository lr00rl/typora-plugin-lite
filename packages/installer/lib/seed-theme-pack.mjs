#!/usr/bin/env node
/**
 * Write the default GitHub theme pack into Typora's official themes folder
 * before the first launch after install. Failure is non-fatal: the plugin
 * fetches the same files on startup.
 */
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'

const OWNER = 'lr00rl'
const REPO = 'Typora_Claude-Like_Theme'
const REF = 'main'
const BOOTLOADER_TYPE = 'typora-plugin-lite-theme-pack'
const BOOTLOADER_VERSION = 1
const USER_AGENT = 'typora-plugin-lite-theme-pack'

function themesDir() {
  const home = homedir()
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library/Application Support/abnerworks.Typora/themes')
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Typora', 'themes')
    default:
      return join(home, '.config', 'Typora', 'themes')
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT },
    }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        resolve(get(new URL(res.headers.location, url).toString()))
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(20_000, () => {
      req.destroy()
      reject(new Error('HTTP timeout'))
    })
  })
}

function destName(path) {
  const name = String(path).replace(/\\/g, '/').split('/').pop() ?? ''
  return name.toLowerCase()
}

async function main() {
  const dir = themesDir()
  mkdirSync(dir, { recursive: true })
  const manifestUrl = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${REF}/theme-pack.json`
  const man = await get(manifestUrl)
  if (man.status !== 200) {
    throw new Error(`theme-pack.json HTTP ${man.status}`)
  }
  const pack = JSON.parse(man.body.toString('utf8'))
  if (pack.typ !== BOOTLOADER_TYPE || pack.version !== BOOTLOADER_VERSION) {
    throw new Error('not a typora-plugin-lite theme pack')
  }
  if (!Array.isArray(pack.files) || pack.files.length === 0) {
    throw new Error('theme-pack.json lists no files')
  }
  for (const entry of pack.files) {
    const path = typeof entry === 'string' ? entry : entry?.path
    if (!path) throw new Error('theme-pack.json file entry is missing path')
    const name = destName(path)
    const dest = join(dir, name)
    try {
      if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
        console.log(`[theme-pack] skip symlink ${name}`)
        continue
      }
    } catch {}
    const file = await get(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${REF}/${path}`)
    if (file.status !== 200) throw new Error(`${path} HTTP ${file.status}`)
    writeFileSync(dest, file.body)
    console.log(`[theme-pack] wrote ${dest}`)
  }
}

main().catch((err) => {
  console.warn(`[theme-pack] seed skipped: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
