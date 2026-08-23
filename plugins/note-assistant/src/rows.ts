/**
 * Row model for the related-notes palette: how graph data becomes display rows
 * per scope, and how the query filters them. Pure and core-free so the whole
 * model is unit-testable; the palette only renders what these functions return.
 *
 * Scope rows arrive pre-ranked by the graph (related/candidates carry its
 * scores; links are deterministic), so filtering preserves order on purpose —
 * re-ranking would fight the graph's own ranking.
 */

import type { GraphNote, RelatedReason } from './types.js'
import { deriveTitleFromTarget, wikiTargetFor } from './links.js'
import { fuzzyMatchPositions } from './match.js'

export type PaletteScope = 'related' | 'links' | 'candidates'

export const SCOPE_ORDER: PaletteScope[] = ['related', 'links', 'candidates']

export const SCOPE_LABELS: Record<PaletteScope, string> = {
  related: '相关',
  links: '链接',
  candidates: '候选',
}

export interface PaletteRow {
  /** Root-relative path with extension, as the graph keys notes. */
  relPath: string
  title: string
  /** One quiet reason badge; empty string renders no badge. */
  badge: string
  /** Precomputed `[[target]]` text for ⌥Enter insertion (extension stripped). */
  target: string
  tags: string[]
}

export interface FilteredRow {
  row: PaletteRow
  /** Highlight positions into `row.title` / `row.relPath`; null = no highlight. */
  titlePositions: number[] | null
  pathPositions: number[] | null
}

export interface RowContext {
  noteMap: Map<string, GraphNote>
  currentFile: string
  rootDir: string
}

/** Single badge per row; explicit relationships outrank proximity outrank terms. */
export function reasonBadge(reasons: RelatedReason | undefined): string {
  if (!reasons) return ''
  if (reasons.explicitLink) return '链接'
  if (reasons.backlink) return '反链'
  if (reasons.sameDirectory) return '同目录'
  if (reasons.sameTopLevel) return '同分区'
  const term = (reasons.sharedTerms || []).find(item => !!item.trim())
  return term ? `共词·${term}` : ''
}

function noteTags(noteMap: Map<string, GraphNote>, relPath: string): string[] {
  return noteMap.get(relPath)?.tags ?? []
}

function noteTitle(noteMap: Map<string, GraphNote>, relPath: string): string {
  return noteMap.get(relPath)?.title || deriveTitleFromTarget(relPath)
}

export function deriveScopeRows(
  note: GraphNote | null,
  scope: PaletteScope,
  context: RowContext,
): PaletteRow[] {
  if (!note) return []
  const { noteMap, currentFile, rootDir } = context
  const toRow = (relPath: string, title: string, badge: string): PaletteRow => ({
    relPath,
    title,
    badge,
    target: wikiTargetFor(relPath, currentFile, rootDir),
    tags: noteTags(noteMap, relPath),
  })

  if (scope === 'links') {
    const seen = new Set<string>()
    const rows: PaletteRow[] = []
    for (const [paths, badge] of [
      [note.explicitLinks ?? [], '出链'],
      [note.backlinks ?? [], '入链'],
    ] as const) {
      for (const relPath of paths) {
        if (seen.has(relPath)) continue
        seen.add(relPath)
        rows.push(toRow(relPath, noteTitle(noteMap, relPath), badge))
      }
    }
    return rows
  }

  const items = scope === 'candidates' ? note.candidates ?? [] : note.related ?? []
  // A partially-populated graph can carry empty titles; derive one rather than
  // render a blank name column (the links scope already does this).
  return items.map(item => toRow(item.relPath, item.title || noteTitle(noteMap, item.relPath), reasonBadge(item.reasons)))
}

/** Order-preserving filter over title, path, and tags; threads highlight positions. */
export function filterRows(rows: PaletteRow[], query: string): FilteredRow[] {
  const q = query.trim()
  if (!q) {
    return rows.map(row => ({ row, titlePositions: null, pathPositions: null }))
  }

  const out: FilteredRow[] = []
  for (const row of rows) {
    const titlePositions = fuzzyMatchPositions(row.title, q)
    const pathPositions = fuzzyMatchPositions(row.relPath, q)
    const tagHit = row.tags.some(tag => fuzzyMatchPositions(tag, q))
    if (!titlePositions && !pathPositions && !tagHit) continue
    out.push({ row, titlePositions, pathPositions })
  }
  return out
}
