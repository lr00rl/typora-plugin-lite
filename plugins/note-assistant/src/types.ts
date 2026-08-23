/**
 * Schema of `.note-assistant/graph.json` as consumed by the plugin.
 * Pure type declarations so both the core-bound graph store and the pure row
 * derivation can share them without a runtime dependency in either direction.
 */

export interface RelatedReason {
  explicitLink?: boolean
  backlink?: boolean
  sameDirectory?: boolean
  sameTopLevel?: boolean
  sharedTerms?: string[]
}

export interface RelatedItem {
  relPath: string
  title: string
  score: number
  reasons: RelatedReason
}

export interface GraphNote {
  relPath: string
  title: string
  topLevel?: string
  tags?: string[]
  suggestedTags?: string[]
  headings?: string[]
  explicitLinks?: string[]
  backlinks?: string[]
  candidates?: RelatedItem[]
  related?: RelatedItem[]
  shouldGenerateBlock?: boolean
  mergeCandidates?: string[]
}

export interface GraphStats {
  totalNotes?: number
  totalNotesScanned?: number
  totalTargetNotes?: number
  graphNotes?: number
  notesWithBlocks?: number
  [key: string]: unknown
}

export interface GraphFile {
  schemaVersion: number
  generatedAt: string
  root: string
  stats: GraphStats
  notes: GraphNote[]
}
