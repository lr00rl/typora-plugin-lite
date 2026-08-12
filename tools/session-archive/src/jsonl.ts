import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'

export interface JsonlRecord {
  line: number
  value: unknown
}

export interface JsonlIssue {
  line: number
  message: string
}

/**
 * Read JSONL one line at a time and reject a source that changes underneath us.
 * Records are handed to the caller immediately so a large transcript does not
 * exist twice in memory (raw text plus parsed object array).
 */
export async function visitStableJsonl(
  path: string,
  visit: (record: JsonlRecord) => void | Promise<void>,
): Promise<JsonlIssue[]> {
  const before = await stat(path)
  const issues: JsonlIssue[] = []
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let line = 0

  try {
    for await (const raw of lines) {
      line += 1
      if (!raw.trim()) continue
      try {
        await visit({ line, value: JSON.parse(raw) })
      } catch (error) {
        issues.push({
          line,
          message: error instanceof Error ? error.message : 'invalid JSON',
        })
      }
    }
  } finally {
    lines.close()
    input.destroy()
  }

  const after = await stat(path)
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`SESSION_SOURCE_CHANGED: ${path}`)
  }

  return issues
}
