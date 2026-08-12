import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

interface TitleRow {
  title?: unknown
}

/**
 * Read Codex's best user-facing thread title without making the state database
 * a hard dependency. Older Node runtimes, missing databases, in-progress Codex
 * migrations, and custom schemas all fall back to the transcript title.
 */
export async function readCodexThreadTitle(
  sqliteHome: string,
  sessionId: string,
): Promise<string | undefined> {
  const path = join(sqliteHome, 'state_5.sqlite')
  try {
    await access(path, constants.R_OK)
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const row = database.prepare(`
        SELECT COALESCE(NULLIF(TRIM(name), ''), NULLIF(TRIM(title), '')) AS title
        FROM threads
        WHERE id = ?
        LIMIT 1
      `).get(sessionId) as TitleRow | undefined
      return typeof row?.title === 'string' && row.title.trim()
        ? row.title.trim()
        : undefined
    } finally {
      database.close()
    }
  } catch {
    return undefined
  }
}
