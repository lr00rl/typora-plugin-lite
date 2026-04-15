import { Plugin, editor, platform } from '@typora-plugin-lite/core'

interface RelatedReason {
  explicitLink?: boolean
  backlink?: boolean
  sameDirectory?: boolean
  sameTopLevel?: boolean
  sharedTerms?: string[]
}

interface RelatedItem {
  relPath: string
  title: string
  score: number
  reasons: RelatedReason
}

interface GraphNote {
  relPath: string
  title: string
  tags?: string[]
  aliases?: string[]
  headings?: string[]
  explicitLinks?: string[]
  backlinks?: string[]
  related?: RelatedItem[]
}

interface GraphStats {
  totalNotes: number
  notesWithFrontmatter: number
  notesWithWikiLinks: number
  explicitLinkEdges: number
  notesWithRelated: number
}

interface GraphFile {
  schemaVersion: number
  generatedAt: string
  root: string
  limit: number
  stats: GraphStats
  notes: GraphNote[]
}

interface InlineRelatedNote {
  rawTarget: string
  displayTitle: string
  pathLabel: string
  reasonText: string
  badges: string[]
}

interface ParsedInlineBlock {
  title: string
  tags: string[]
  items: InlineRelatedNote[]
}

interface InlineTargetResolution {
  rawTarget: string
  normalizedTarget: string
  candidates: string[]
}

type PanelMode = 'visual' | 'source'

const HOTKEY = 'Mod+;'
const GRAPH_DIR = '.note-assistant'
const GRAPH_FILE = 'graph.json'
const BUILD_SCRIPT = 'tools/note-assistant/build-graph.mjs'
const PANEL_ID = 'tpl-note-assistant'
const BLOCK_START = '<!-- note-assistant:start -->'
const BLOCK_END = '<!-- note-assistant:end -->'
const INLINE_COLLAPSE_LIMIT = 15
const PANEL_COLLAPSE_LIMIT = 15

const CSS = `
#${PANEL_ID}-overlay {
  position: fixed;
  inset: 0;
  z-index: 99998;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 8vh;
  background: rgba(0, 0, 0, 0.45);
}
#${PANEL_ID}-panel {
  width: min(920px, 94vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 12px;
  background: var(--bg-color, #fff);
  color: var(--text-color, inherit);
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.18));
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
}
#${PANEL_ID}-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
}
#${PANEL_ID}-title-wrap {
  min-width: 0;
}
#${PANEL_ID}-title {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.25;
  margin-bottom: 4px;
  word-break: break-word;
}
#${PANEL_ID}-subtitle {
  opacity: 0.62;
  font-size: 12px;
  line-height: 1.4;
  word-break: break-all;
}
#${PANEL_ID}-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.${PANEL_ID}-btn {
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.22));
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
}
.${PANEL_ID}-btn:hover {
  background: rgba(127, 127, 127, 0.08);
}
.${PANEL_ID}-btn-primary {
  border-color: color-mix(in srgb, rgba(83, 124, 255, 0.44) 84%, transparent 16%);
  background: linear-gradient(180deg, #4f7dff, #3e68e9);
  color: #fff;
  box-shadow: 0 10px 24px rgba(79, 125, 255, 0.24);
}
.${PANEL_ID}-btn-primary:hover {
  background: linear-gradient(180deg, #5d88ff, #466fef);
}
.${PANEL_ID}-btn-quiet {
  border-color: transparent;
  background: transparent;
  opacity: 0.74;
}
.${PANEL_ID}-btn-quiet:hover {
  opacity: 1;
  background: rgba(127, 127, 127, 0.08);
}
.${PANEL_ID}-btn:disabled {
  cursor: default;
  opacity: 0.55;
  box-shadow: none;
}
#${PANEL_ID}-body {
  overflow: auto;
  padding: 10px 16px 16px;
}
.${PANEL_ID}-status {
  padding: 18px 6px;
  opacity: 0.68;
  line-height: 1.5;
}
.${PANEL_ID}-section {
  margin-top: 14px;
}
.${PANEL_ID}-section:first-child {
  margin-top: 0;
}
.${PANEL_ID}-section-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.48;
  margin: 0 0 8px;
}
.${PANEL_ID}-card {
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.14));
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.${PANEL_ID}-row-top {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.${PANEL_ID}-check {
  margin-top: 3px;
}
.${PANEL_ID}-row-main {
  flex: 1;
  min-width: 0;
}
.${PANEL_ID}-row-title {
  font-weight: 600;
  line-height: 1.35;
  margin-bottom: 3px;
  word-break: break-word;
}
.${PANEL_ID}-row-path {
  font-size: 12px;
  opacity: 0.65;
  word-break: break-all;
}
.${PANEL_ID}-row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.${PANEL_ID}-badge {
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 8px;
  background: rgba(127, 127, 127, 0.1);
  opacity: 0.88;
}
.${PANEL_ID}-reasons {
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.74;
  line-height: 1.45;
}
.${PANEL_ID}-row-actions {
  display: flex;
  gap: 8px;
}
.${PANEL_ID}-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px 14px;
  border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
  font-size: 12px;
  opacity: 0.66;
}
#write.tpl-has-note-assistant-block .tpl-note-assistant-comment {
  display: none;
}
#write.tpl-has-note-assistant-block .tpl-note-assistant-source-hidden {
  display: none !important;
}
#write .tpl-note-assistant-inline {
  position: relative;
  margin: 22px 0 26px;
  padding: 18px 18px 16px;
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--border-color, rgba(128, 128, 128, 0.16)) 88%, #7aa2f7 12%);
  background:
    radial-gradient(circle at top right, rgba(122, 162, 247, 0.16), transparent 36%),
    linear-gradient(180deg, color-mix(in srgb, var(--bg-color, #fff) 92%, #eef4ff 8%), color-mix(in srgb, var(--bg-color, #fff) 97%, #dfeaff 3%));
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
}
#write .tpl-note-assistant-inline::before {
  content: 'NOTE ASSISTANT';
  position: absolute;
  top: -10px;
  left: 16px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  letter-spacing: 0.12em;
  background: color-mix(in srgb, var(--bg-color, #fff) 74%, #7aa2f7 26%);
  color: color-mix(in srgb, var(--text-color, #222) 65%, #284a8a 35%);
}
#write .tpl-note-assistant-inline-header {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: flex-start;
}
#write .tpl-note-assistant-inline-title-wrap {
  min-width: 0;
}
#write .tpl-note-assistant-inline-title {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.2;
  margin: 0;
}
#write .tpl-note-assistant-inline-subtitle {
  margin-top: 5px;
  font-size: 12px;
  opacity: 0.66;
  line-height: 1.45;
}
#write .tpl-note-assistant-inline-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
#write .tpl-note-assistant-inline-btn {
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--border-color, rgba(128, 128, 128, 0.2)) 84%, #7aa2f7 16%);
  background: color-mix(in srgb, var(--bg-color, #fff) 85%, #f6f9ff 15%);
  color: inherit;
  border-radius: 10px;
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
#write .tpl-note-assistant-inline-btn:hover {
  background: color-mix(in srgb, var(--bg-color, #fff) 70%, #e8f0ff 30%);
}
#write .tpl-note-assistant-inline-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
#write .tpl-note-assistant-inline-tag {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, rgba(122, 162, 247, 0.22) 80%, transparent 20%);
  background: color-mix(in srgb, var(--bg-color, #fff) 76%, #e7efff 24%);
  font-size: 12px;
  color: color-mix(in srgb, var(--text-color, #222) 82%, #365ea7 18%);
}
#write .tpl-note-assistant-inline-list {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}
#write .tpl-note-assistant-inline-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  width: 100%;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--border-color, rgba(128, 128, 128, 0.14)) 86%, #7aa2f7 14%);
  background: color-mix(in srgb, var(--bg-color, #fff) 94%, #f7faff 6%);
  text-align: left;
  color: inherit;
  cursor: pointer;
}
#write .tpl-note-assistant-inline-card:hover {
  transform: translateY(-1px);
  background: color-mix(in srgb, var(--bg-color, #fff) 82%, #eef4ff 18%);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
}
#write .tpl-note-assistant-inline-card-main {
  min-width: 0;
  flex: 1;
}
#write .tpl-note-assistant-inline-card-title {
  font-weight: 650;
  line-height: 1.35;
  word-break: break-word;
}
#write .tpl-note-assistant-inline-card-path {
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.62;
  word-break: break-all;
}
#write .tpl-note-assistant-inline-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
#write .tpl-note-assistant-inline-badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.1);
  font-size: 11px;
  opacity: 0.9;
}
#write .tpl-note-assistant-inline-card-reason {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.45;
  opacity: 0.76;
}
#write .tpl-note-assistant-inline-open {
  font-size: 12px;
  opacity: 0.56;
  white-space: nowrap;
  padding-top: 3px;
}
#write .tpl-note-assistant-inline-empty {
  padding: 10px 0 2px;
  font-size: 13px;
  opacity: 0.66;
}
#${PANEL_ID}-overlay {
  padding-top: 4vh;
  backdrop-filter: blur(12px);
  background: rgba(12, 18, 28, 0.48);
}
#${PANEL_ID}-panel {
  width: min(1080px, 95vw);
  max-height: 88vh;
  border-radius: 24px;
  border: 1px solid color-mix(in srgb, var(--border-color, rgba(128, 128, 128, 0.18)) 84%, #8cb4ff 16%);
  background:
    radial-gradient(circle at top right, rgba(140, 180, 255, 0.16), transparent 32%),
    linear-gradient(180deg, color-mix(in srgb, var(--bg-color, #fff) 96%, #f5f8ff 4%), color-mix(in srgb, var(--bg-color, #fff) 98%, #eef3ff 2%));
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.26);
}
#${PANEL_ID}-header {
  padding: 22px 24px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color, rgba(128, 128, 128, 0.16)) 78%, #9ebfff 22%);
}
#${PANEL_ID}-title {
  font-size: 24px;
  line-height: 1.15;
  letter-spacing: -0.01em;
}
#${PANEL_ID}-subtitle {
  font-size: 13px;
  opacity: 0.7;
}
#${PANEL_ID}-body {
  display: grid;
  gap: 16px;
  padding: 18px 22px 24px;
}
.${PANEL_ID}-section {
  margin-top: 0;
  padding: 16px;
  border-radius: 20px;
  border: 1px solid color-mix(in srgb, var(--border-color, rgba(128, 128, 128, 0.14)) 84%, #a9c5ff 16%);
  background: color-mix(in srgb, var(--bg-color, #fff) 96%, #f8fbff 4%);
}
.${PANEL_ID}-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.${PANEL_ID}-section-title {
  margin: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.54;
}
.${PANEL_ID}-section-count {
  min-width: 28px;
  height: 28px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg-color, #fff) 72%, #dfeaff 28%);
  font-size: 12px;
  font-weight: 600;
}
.${PANEL_ID}-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(220px, 0.9fr);
  gap: 18px;
}
.${PANEL_ID}-hero-main {
  min-width: 0;
}
.${PANEL_ID}-hero-eyebrow {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.52;
}
.${PANEL_ID}-hero-title {
  margin-top: 8px;
  font-size: 26px;
  line-height: 1.15;
  font-weight: 720;
  word-break: break-word;
}
.${PANEL_ID}-hero-path {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.45;
  opacity: 0.66;
  word-break: break-all;
}
.${PANEL_ID}-hero-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.${PANEL_ID}-hero-summary {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}
.${PANEL_ID}-hero-summary > div {
  display: grid;
  gap: 4px;
}
.${PANEL_ID}-hero-summary strong {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.5;
}
.${PANEL_ID}-hero-summary span {
  font-size: 13px;
  line-height: 1.45;
  opacity: 0.82;
  word-break: break-word;
}
.${PANEL_ID}-hero-stats {
  display: grid;
  gap: 10px;
  align-content: start;
}
.${PANEL_ID}-hero-stat {
  padding: 14px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--bg-color, #fff) 75%, #e7efff 25%);
  border: 1px solid color-mix(in srgb, rgba(140, 180, 255, 0.2) 80%, transparent 20%);
}
.${PANEL_ID}-hero-stat strong {
  display: block;
  font-size: 22px;
  line-height: 1.1;
}
.${PANEL_ID}-hero-stat span {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.68;
}
.${PANEL_ID}-list {
  display: grid;
  gap: 8px;
}
.${PANEL_ID}-section-toggle {
  justify-self: start;
  margin-top: 4px;
}
.${PANEL_ID}-card {
  padding: 10px 12px;
  margin-bottom: 0;
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-color, #fff) 98%, #eff5ff 2%);
}
.${PANEL_ID}-row-top {
  gap: 12px;
}
.${PANEL_ID}-row-title {
  margin-bottom: 2px;
  font-size: 14px;
}
.${PANEL_ID}-row-path {
  font-size: 12px;
}
.${PANEL_ID}-row-meta {
  gap: 6px;
  margin-top: 6px;
}
.${PANEL_ID}-badge {
  min-height: 22px;
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg-color, #fff) 80%, #dde9ff 20%);
  font-size: 11px;
}
.${PANEL_ID}-row-actions .${PANEL_ID}-btn {
  padding: 6px 9px;
}
#write .tpl-note-assistant-inline {
  padding: 14px 14px 12px;
  border-radius: 16px;
}
#write .tpl-note-assistant-inline-header {
  align-items: center;
}
#write .tpl-note-assistant-inline-title {
  font-size: 16px;
}
#write .tpl-note-assistant-inline-subtitle {
  margin-top: 4px;
}
#write .tpl-note-assistant-inline-list {
  gap: 8px;
  margin-top: 14px;
}
#write .tpl-note-assistant-inline-card {
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
}
#write .tpl-note-assistant-inline-card-title {
  font-size: 14px;
}
#write .tpl-note-assistant-inline-card-path {
  margin-top: 2px;
  font-size: 11px;
}
#write .tpl-note-assistant-inline-card-meta {
  margin-top: 6px;
}
#write .tpl-note-assistant-inline-card-reason {
  display: none;
}
#write .tpl-note-assistant-inline-open {
  padding-top: 2px;
  font-size: 11px;
}
#write .tpl-note-assistant-inline-toggle {
  justify-self: start;
  margin-top: 4px;
}
#${PANEL_ID}-editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(10, 14, 22, 0.58);
  backdrop-filter: blur(10px);
}
#${PANEL_ID}-editor-panel {
  width: min(880px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 22px;
  border: 1px solid color-mix(in srgb, var(--border-color, rgba(128, 128, 128, 0.2)) 80%, #97bbff 20%);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-color, #fff) 96%, #f5f9ff 4%), color-mix(in srgb, var(--bg-color, #fff) 99%, #eef3ff 1%));
  box-shadow: 0 28px 72px rgba(0, 0, 0, 0.28);
}
.${PANEL_ID}-editor-header {
  padding: 18px 20px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color, rgba(128, 128, 128, 0.16)) 78%, #9ebfff 22%);
}
.${PANEL_ID}-editor-title {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
}
.${PANEL_ID}-editor-subtitle {
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.68;
  line-height: 1.45;
}
.${PANEL_ID}-editor-body {
  display: grid;
  gap: 12px;
  padding: 16px 20px 20px;
}
.${PANEL_ID}-editor-info {
  font-size: 12px;
  opacity: 0.66;
  word-break: break-all;
}
.${PANEL_ID}-editor-textarea {
  width: 100%;
  min-height: min(58vh, 560px);
  resize: vertical;
  border: 1px solid color-mix(in srgb, var(--border-color, rgba(128, 128, 128, 0.2)) 78%, #97bbff 22%);
  border-radius: 16px;
  padding: 14px 16px;
  background: color-mix(in srgb, var(--bg-color, #fff) 98%, #f8fbff 2%);
  color: inherit;
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace;
}
.${PANEL_ID}-editor-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.${PANEL_ID}-footer-status {
  min-width: 0;
  word-break: break-word;
}
.${PANEL_ID}-footer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
.${PANEL_ID}-mode-section {
  padding: 10px 12px;
}
.${PANEL_ID}-mode-tabs {
  display: inline-flex;
  gap: 6px;
  padding: 4px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-color, #fff) 78%, #e4ecff 22%);
}
.${PANEL_ID}-mode-btn {
  min-width: 92px;
}
.${PANEL_ID}-mode-btn-active {
  background: linear-gradient(180deg, #4f7dff, #3e68e9);
  color: #fff;
  border-color: transparent;
  box-shadow: 0 8px 18px rgba(79, 125, 255, 0.22);
  opacity: 1;
}
.${PANEL_ID}-workspace-helper {
  margin-bottom: 14px;
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.72;
}
.${PANEL_ID}-workspace-group {
  margin-top: 16px;
}
.${PANEL_ID}-workspace-label {
  margin-bottom: 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.5;
}
.${PANEL_ID}-workspace-empty {
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.68;
}
.${PANEL_ID}-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.${PANEL_ID}-editable-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 8px 0 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, rgba(122, 162, 247, 0.22) 80%, transparent 20%);
  background: color-mix(in srgb, var(--bg-color, #fff) 80%, #e7efff 20%);
  font-size: 12px;
}
.${PANEL_ID}-chip-btn {
  padding: 4px 6px;
  font-size: 11px;
}
.${PANEL_ID}-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
}
.${PANEL_ID}-input {
  flex: 1;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--border-color, rgba(128, 128, 128, 0.2)) 78%, #97bbff 22%);
  border-radius: 12px;
  padding: 9px 12px;
  background: color-mix(in srgb, var(--bg-color, #fff) 98%, #f8fbff 2%);
  color: inherit;
  font: inherit;
}
@media (max-width: 900px) {
  .${PANEL_ID}-hero {
    grid-template-columns: 1fr;
  }
  #${PANEL_ID}-header,
  #${PANEL_ID}-body {
    padding-left: 16px;
    padding-right: 16px;
  }
}
`

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/')
}

function splitPath(input: string): string[] {
  return normalizePath(input).split('/').filter(Boolean)
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim()) return value
  }
  return ''
}

function getRootPrefix(input: string): string {
  const normalized = normalizePath(input)
  const drive = normalized.match(/^[A-Za-z]:/)
  if (drive) return drive[0].toLowerCase()
  return normalized.startsWith('/') ? '/' : ''
}

function relPathFromRoot(absPath: string, root: string): string {
  const normalizedAbs = normalizePath(absPath)
  const normalizedRoot = normalizePath(root)
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : normalizedRoot + '/'
  if (normalizedAbs.startsWith(prefix)) {
    return normalizedAbs.slice(prefix.length)
  }
  return normalizedAbs
}

function relPathFromDir(absPath: string, baseDir: string): string {
  const target = normalizePath(absPath)
  const base = normalizePath(baseDir)
  if (!base || getRootPrefix(target) !== getRootPrefix(base)) return target

  const targetParts = splitPath(target)
  const baseParts = splitPath(base)
  let shared = 0
  while (
    shared < targetParts.length &&
    shared < baseParts.length &&
    targetParts[shared] === baseParts[shared]
  ) {
    shared += 1
  }

  const up = baseParts.slice(shared).map(() => '..')
  const down = targetParts.slice(shared)
  return [...up, ...down].join('/') || '.'
}

function withoutMarkdownExt(input: string): string {
  return input.replace(/\.(md|markdown)$/i, '')
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch
  ))
}

export default class NoteAssistantPlugin extends Plugin {
  private observer: MutationObserver | null = null
  private rafId = 0
  private writeEl: HTMLElement | null = null
  private observerConnected = false
  private processRunId = 0
  private overlay: HTMLDivElement | null = null
  private bodyEl: HTMLDivElement | null = null
  private titleEl: HTMLDivElement | null = null
  private subtitleEl: HTMLDivElement | null = null
  private footerEl: HTMLDivElement | null = null
  private panelStatusEl: HTMLDivElement | null = null
  private editorOverlay: HTMLDivElement | null = null
  private editorTextarea: HTMLTextAreaElement | null = null
  private editorInfoEl: HTMLDivElement | null = null
  private panelCloseBtn: HTMLButtonElement | null = null
  private panelSaveBtn: HTMLButtonElement | null = null
  private panelSaveRefreshBtn: HTMLButtonElement | null = null
  private panelRefreshBtn: HTMLButtonElement | null = null
  private panelRebuildBtn: HTMLButtonElement | null = null
  private panelEditBtn: HTMLButtonElement | null = null
  private panelUpdateBtn: HTMLButtonElement | null = null
  private editorCancelBtn: HTMLButtonElement | null = null
  private editorSaveBtn: HTMLButtonElement | null = null
  private editorSaveRefreshBtn: HTMLButtonElement | null = null
  private graphCache: GraphFile | null = null
  private graphPath = ''
  private graphRoot = ''
  private graphMtime = 0
  private noteMap: Map<string, GraphNote> = new Map()
  private selectionMap = new Map<string, HTMLInputElement>()
  private expandedInlineKeys = new Set<string>()
  private expandedPanelSections = new Set<string>()
  private currentPanelNoteRelPath = ''
  private panelMode: PanelMode = 'visual'
  private panelDraft: ParsedInlineBlock = { title: 'Note Assistant', tags: [], items: [] }
  private panelSourceDraft = ''
  private panelDraftDirty = false
  private panelHasExistingBlock = false
  private panelLoadedFile = ''
  private panelLoadedBlockMarkdown = ''
  private editorSaveInFlight = false
  private rebuildInFlight = false
  private keydownHandler: ((evt: KeyboardEvent) => void) | null = null

  onload(): void {
    this.registerCss(CSS)
    this.logChannel('lifecycle', 'onload')
    this.writeEl = document.getElementById('write')
    if (this.writeEl) {
      this.processNoteAssistantBlocks(this.writeEl)
      this.observer = new MutationObserver((mutations) => {
        if (this.shouldIgnoreMutations(mutations)) {
          this.debugChannel('observer', 'ignored self mutations', { count: mutations.length })
          return
        }
        this.debugChannel('observer', 'schedule from mutations', { count: mutations.length })
        this.scheduleProcess()
      })
      this.connectObserver()
      this.registerDomEvent(this.writeEl, 'input', () => this.scheduleProcess())
      this.registerDomEvent(this.writeEl, 'focusin', () => this.scheduleProcess(), { capture: true })
    }

    this.registerHotkey(HOTKEY, () => void this.open())
    this.registerCommand({
      id: 'note-assistant:open',
      name: 'Note Assistant: Open',
      callback: () => this.open(),
    })
    this.registerCommand({
      id: 'note-assistant:rebuild-graph',
      name: 'Note Assistant: Rebuild Graph',
      callback: () => void this.rebuildGraph(),
    })
    this.registerCommand({
      id: 'note-assistant:reparse-document',
      name: 'Note Assistant: Reparse Current Document',
      callback: () => this.reparseDocument(),
    })
  }

  onunload(): void {
    this.disconnectObserver()
    cancelAnimationFrame(this.rafId)
    if (this.writeEl) {
      this.writeEl.classList.remove('tpl-has-note-assistant-block')
      this.clearNoteAssistantClasses(this.writeEl)
    }
    this.close()
  }

  private scheduleProcess(): void {
    cancelAnimationFrame(this.rafId)
    const runId = ++this.processRunId
    this.debugChannel('observer', 'schedule process', { runId })
    this.rafId = requestAnimationFrame(() => {
      if (this.writeEl) this.processNoteAssistantBlocks(this.writeEl)
    })
  }

  private async open(): Promise<void> {
    if (this.overlay) {
      this.close()
      return
    }
    this.buildModal()
    await this.renderCurrentNote()
  }

  private async openPanelMode(mode: PanelMode): Promise<void> {
    this.panelMode = mode
    if (!this.overlay) {
      this.buildModal()
    }
    await this.renderCurrentNote()
  }

  private close(): void {
    this.selectionMap.clear()
    this.closeBlockEditor()
    if (this.keydownHandler) {
      window.removeEventListener('keydown', this.keydownHandler)
      this.keydownHandler = null
    }
    this.overlay?.remove()
    this.overlay = null
    this.bodyEl = null
    this.titleEl = null
    this.subtitleEl = null
    this.footerEl = null
    this.panelStatusEl = null
    this.panelCloseBtn = null
    this.panelSaveBtn = null
    this.panelSaveRefreshBtn = null
    this.panelRefreshBtn = null
    this.panelRebuildBtn = null
    this.panelEditBtn = null
    this.panelUpdateBtn = null
    this.editorTextarea = null
    this.editorInfoEl = null
    this.panelMode = 'visual'
    this.panelDraftDirty = false
    this.panelLoadedFile = ''
    this.panelLoadedBlockMarkdown = ''
  }

  private buildModal(): void {
    const overlay = document.createElement('div')
    overlay.id = `${PANEL_ID}-overlay`
    overlay.addEventListener('click', evt => {
      if (evt.target === overlay) this.close()
    })

    const panel = document.createElement('div')
    panel.id = `${PANEL_ID}-panel`
    panel.addEventListener('click', evt => evt.stopPropagation())

    const header = document.createElement('div')
    header.id = `${PANEL_ID}-header`

    const titleWrap = document.createElement('div')
    titleWrap.id = `${PANEL_ID}-title-wrap`
    const title = document.createElement('div')
    title.id = `${PANEL_ID}-title`
    title.textContent = 'Note Assistant'
    const subtitle = document.createElement('div')
    subtitle.id = `${PANEL_ID}-subtitle`
    subtitle.textContent = 'Loading...'
    titleWrap.appendChild(title)
    titleWrap.appendChild(subtitle)

    const actions = document.createElement('div')
    actions.id = `${PANEL_ID}-actions`
    this.panelRefreshBtn = this.makeButton('Refresh Suggestions', () => void this.rebuildGraph(), { variant: 'quiet' })
    this.panelRebuildBtn = null
    this.panelEditBtn = null
    this.panelUpdateBtn = null
    actions.appendChild(this.panelRefreshBtn)

    header.appendChild(titleWrap)
    header.appendChild(actions)

    const body = document.createElement('div')
    body.id = `${PANEL_ID}-body`

    const footer = document.createElement('div')
    footer.id = `${PANEL_ID}-footer`
    const status = document.createElement('div')
    status.className = `${PANEL_ID}-footer-status`
    status.textContent = `${HOTKEY} to open, Esc to close`
    const footerActions = document.createElement('div')
    footerActions.className = `${PANEL_ID}-footer-actions`
    this.panelCloseBtn = this.makeButton('Close', () => this.close(), { variant: 'quiet' })
    this.panelSaveBtn = this.makeButton('Save', () => void this.saveBlockEditor(false))
    this.panelSaveRefreshBtn = this.makeButton('Save & Refresh', () => void this.saveBlockEditor(true), { variant: 'primary' })
    footerActions.appendChild(this.panelCloseBtn)
    footerActions.appendChild(this.panelSaveBtn)
    footerActions.appendChild(this.panelSaveRefreshBtn)
    footer.appendChild(status)
    footer.appendChild(footerActions)

    panel.appendChild(header)
    panel.appendChild(body)
    panel.appendChild(footer)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)

    this.overlay = overlay
    this.bodyEl = body
    this.titleEl = title
    this.subtitleEl = subtitle
    this.footerEl = footer
    this.panelStatusEl = status

    this.keydownHandler = (evt: KeyboardEvent) => {
      if ((evt.metaKey || evt.ctrlKey) && evt.key.toLowerCase() === 's' && this.overlay) {
        evt.preventDefault()
        void this.saveBlockEditor(false)
        return
      }
      if (evt.key === 'Escape') {
        this.close()
      }
    }
    window.addEventListener('keydown', this.keydownHandler)
  }

  private makeButton(
    label: string,
    onClick: () => void,
    options: { variant?: 'primary' | 'quiet' } = {},
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = `${PANEL_ID}-btn`
    if (options.variant === 'primary') btn.classList.add(`${PANEL_ID}-btn-primary`)
    if (options.variant === 'quiet') btn.classList.add(`${PANEL_ID}-btn-quiet`)
    btn.textContent = label
    btn.dataset.label = label
    btn.addEventListener('click', evt => {
      evt.preventDefault()
      if (btn.disabled) return
      onClick()
    })
    return btn
  }

  private getCurrentSearchRoots(): string[] {
    const win = window as any
    const watched = editor.getWatchedFolder()
    const currentFile = editor.getFilePath()
    const mountFolder = firstNonEmpty(
      watched,
      win.File?.getMountFolder?.(),
      win._options?.mountFolder,
      currentFile ? platform.path.dirname(currentFile) : '',
    )
    return [...new Set([watched, mountFolder, currentFile ? platform.path.dirname(currentFile) : ''].filter((value): value is string => !!value))]
  }

  private getFallbackRootDir(): string {
    return firstNonEmpty(editor.getWatchedFolder(), this.graphRoot, editor.getFilePath() ? platform.path.dirname(editor.getFilePath()) : '')
  }

  private async findUpwardsForFile(relativePath: string): Promise<{ root: string; absPath: string } | null> {
    for (const start of this.getCurrentSearchRoots()) {
      let dir = start
      const seen = new Set<string>()
      while (dir && !seen.has(dir)) {
        seen.add(dir)
        const candidate = platform.path.join(dir, relativePath)
        if (await platform.fs.exists(candidate)) {
          return { root: dir, absPath: candidate }
        }
        const parent = platform.path.dirname(dir)
        if (!parent || parent === dir) break
        dir = parent
      }
    }
    return null
  }

  private async loadGraph(force = false): Promise<GraphFile | null> {
    const located = await this.findUpwardsForFile(platform.path.join(GRAPH_DIR, GRAPH_FILE))
    if (!located) {
      this.graphCache = null
      this.graphPath = ''
      this.graphRoot = ''
      this.graphMtime = 0
      this.noteMap.clear()
      return null
    }

    const stat = await platform.fs.stat(located.absPath)
    const mtime = stat.mtimeMs ?? 0
    if (
      this.graphCache &&
      !force &&
      this.graphPath === located.absPath &&
      this.graphRoot === located.root &&
      this.graphMtime === mtime
    ) {
      return this.graphCache
    }

    try {
      const text = await platform.fs.readText(located.absPath)
      const parsed = JSON.parse(text) as GraphFile
      this.graphCache = parsed
      this.graphPath = located.absPath
      this.graphRoot = located.root
      this.graphMtime = mtime
      this.noteMap = new Map(parsed.notes.map(note => [note.relPath, note]))
      return parsed
    } catch (err) {
      console.error('[tpl:note-assistant] failed to load graph', err)
      this.graphCache = null
      this.graphPath = ''
      this.graphRoot = ''
      this.graphMtime = 0
      this.noteMap.clear()
      return null
    }
  }

  private async renderCurrentNote(force = false): Promise<void> {
    if (!this.bodyEl || !this.titleEl || !this.subtitleEl || !this.footerEl) return

    const currentFile = editor.getFilePath()
    const graph = await this.loadGraph(force)
    const root = graph?.root || this.graphRoot || this.getFallbackRootDir()

    if (!root || !currentFile) {
      this.renderStatus('Open the note inside a watched folder first. The plugin needs a vault root.')
      this.titleEl.textContent = 'Note Assistant'
      this.subtitleEl.textContent = 'No watched folder detected'
      return
    }

    const relPath = relPathFromRoot(currentFile, root)
    const note = graph ? (this.noteMap.get(relPath) || null) : null
    this.currentPanelNoteRelPath = relPath
    this.ensurePanelDraftInitialized(currentFile, relPath)

    this.titleEl.textContent = note?.title || platform.path.basename(currentFile)
    this.subtitleEl.textContent = relPath

    this.selectionMap.clear()
    this.bodyEl.innerHTML = ''

    this.bodyEl.appendChild(this.renderWorkspaceHero(currentFile, relPath, note, graph))
    this.bodyEl.appendChild(this.renderModeSwitch())
    if (this.panelMode === 'visual') {
      this.bodyEl.appendChild(this.renderCurrentBlockSection(currentFile))
      this.bodyEl.appendChild(this.renderSuggestionsWorkspaceSection(note, graph, currentFile))
    } else {
      this.bodyEl.appendChild(this.renderSourceWorkspace())
    }

    this.setPanelFooterStatus(root, note, graph)
    this.setPanelSaveState(this.editorSaveInFlight)
  }

  private renderStatus(message: string): void {
    if (!this.bodyEl) return
    this.bodyEl.innerHTML = `<div class="${PANEL_ID}-status">${escapeHtml(message)}</div>`
  }

  private ensurePanelDraftInitialized(currentFile: string, relPath: string): void {
    const markdown = editor.getMarkdown() || ''
    const blockMarkdown = extractNoteAssistantBlock(markdown) || ''
    const shouldReset = this.panelLoadedFile !== currentFile
      || (!this.panelDraftDirty && blockMarkdown !== this.panelLoadedBlockMarkdown)

    if (!shouldReset) return

    this.panelLoadedFile = currentFile
    this.panelLoadedBlockMarkdown = blockMarkdown
    this.panelHasExistingBlock = !!blockMarkdown
    this.panelDraft = this.normalizeParsedBlock(
      blockMarkdown
        ? this.parseBlockMarkdown(blockMarkdown)
        : this.buildDefaultParsedBlock(relPath),
    )
    this.panelSourceDraft = this.composeNoteAssistantBlock(this.panelDraft)
    this.panelDraftDirty = false
  }

  private buildDefaultParsedBlock(relPath: string): ParsedInlineBlock {
    const note = relPath ? this.noteMap.get(relPath) : null
    return {
      title: 'Note Assistant',
      tags: (note?.tags || []).slice(0, 5),
      items: [],
    }
  }

  private parseBlockMarkdown(blockMarkdown: string): ParsedInlineBlock {
    const normalized = blockMarkdown
      .replace(/\r\n/g, '\n')
      .replace(BLOCK_START, '')
      .replace(BLOCK_END, '')

    const title = normalized.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || 'Note Assistant'
    const tagsLine = normalized
      .split('\n')
      .map(line => line.trim())
      .find(line => line.startsWith('Tags:')) || ''
    const tags = [...new Set((tagsLine.match(/#([^\s#]+)/g) || []).map(item => item.slice(1)).filter(Boolean))]
    const items = normalized
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^[-*+]\s+/.test(line))
      .map(line => this.parseInlineRelatedNote(line.replace(/^[-*+]\s+/, '')))
      .filter((item): item is InlineRelatedNote => !!item)

    return { title, tags, items }
  }

  private normalizeParsedBlock(data: ParsedInlineBlock): ParsedInlineBlock {
    const seen = new Set<string>()
    const items = data.items.filter(item => {
      const key = withoutMarkdownExt(item.rawTarget.split('#')[0].trim())
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    return {
      title: firstNonEmpty(data.title, 'Note Assistant'),
      tags: [...new Set(data.tags.map(tag => tag.trim()).filter(Boolean))],
      items,
    }
  }

  private renderWorkspaceHero(
    currentFile: string,
    relPath: string,
    note: GraphNote | null,
    graph: GraphFile | null,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = `${PANEL_ID}-section ${PANEL_ID}-hero`

    const main = document.createElement('div')
    main.className = `${PANEL_ID}-hero-main`
    main.innerHTML = `
      <div class="${PANEL_ID}-hero-eyebrow">Relationships</div>
      <div class="${PANEL_ID}-hero-title">${escapeHtml(note?.title || platform.path.basename(currentFile))}</div>
      <div class="${PANEL_ID}-hero-path">${escapeHtml(relPath)}</div>
    `

    const tags = document.createElement('div')
    tags.className = `${PANEL_ID}-hero-tags`
    for (const tag of this.panelDraft.tags.slice(0, 8)) {
      tags.appendChild(this.makeBadge(`#${tag}`))
    }
    if (tags.childElementCount) main.appendChild(tags)

    const summary = document.createElement('div')
    summary.className = `${PANEL_ID}-hero-summary`
    summary.innerHTML = `
      <div><strong>Current Block</strong><span>${this.panelHasExistingBlock ? 'Present in document' : 'Not created yet'}</span></div>
      <div><strong>Suggestions</strong><span>${graph ? (note ? 'Graph suggestions available' : 'Refresh graph to index this note') : 'Graph unavailable'}</span></div>
      <div><strong>Mode</strong><span>${this.panelMode === 'visual' ? 'Visual editing' : 'Source editing'}</span></div>
    `

    const stats = document.createElement('div')
    stats.className = `${PANEL_ID}-hero-stats`
    const statItems: Array<[string, string | number]> = [
      ['Tags', this.panelDraft.tags.length],
      ['Links', this.panelDraft.items.length],
      ['Indexed', graph ? graph.stats.totalNotes : 'n/a'],
      ['Graph', graph ? (note ? 'ready' : 'pending') : 'missing'],
    ]
    for (const [label, value] of statItems) {
      const stat = document.createElement('div')
      stat.className = `${PANEL_ID}-hero-stat`
      stat.innerHTML = `<strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span>`
      stats.appendChild(stat)
    }

    section.appendChild(main)
    main.appendChild(summary)
    section.appendChild(stats)
    return section
  }

  private renderModeSwitch(): HTMLElement {
    const wrap = document.createElement('section')
    wrap.className = `${PANEL_ID}-section ${PANEL_ID}-mode-section`

    const tabs = document.createElement('div')
    tabs.className = `${PANEL_ID}-mode-tabs`
    tabs.appendChild(this.makeModeButton('Visual', 'visual'))
    tabs.appendChild(this.makeModeButton('Source', 'source'))
    wrap.appendChild(tabs)
    return wrap
  }

  private makeModeButton(label: string, mode: PanelMode): HTMLButtonElement {
    const button = this.makeButton(label, () => this.setPanelMode(mode), { variant: 'quiet' })
    button.classList.add(`${PANEL_ID}-mode-btn`)
    if (this.panelMode === mode) {
      button.classList.add(`${PANEL_ID}-mode-btn-active`)
    }
    return button
  }

  private setPanelMode(mode: PanelMode): void {
    if (mode === this.panelMode) return
    if (mode === 'source') {
      this.panelSourceDraft = this.composeNoteAssistantBlock(this.panelDraft)
    } else {
      this.panelDraft = this.normalizeParsedBlock(this.parseBlockMarkdown(this.panelSourceDraft))
    }
    this.panelMode = mode
    void this.renderCurrentNote()
  }

  private renderCurrentBlockSection(currentFile: string): HTMLElement {
    const section = document.createElement('section')
    section.className = `${PANEL_ID}-section`
    section.appendChild(this.makeSectionHeading('Current Block', this.panelDraft.items.length))

    const helper = document.createElement('div')
    helper.className = `${PANEL_ID}-workspace-helper`
    helper.textContent = this.panelHasExistingBlock
      ? 'These are the relationships currently stored in the document block.'
      : 'No relationship block exists yet. Changes here will create one when you save.'
    section.appendChild(helper)

    const tagWrap = document.createElement('div')
    tagWrap.className = `${PANEL_ID}-workspace-group`
    tagWrap.appendChild(this.makeWorkspaceLabel('Tags'))
    const tagList = document.createElement('div')
    tagList.className = `${PANEL_ID}-tag-list`
    for (const tag of this.panelDraft.tags) {
      tagList.appendChild(this.makeEditableTagChip(tag))
    }
    if (!tagList.childElementCount) {
      const empty = document.createElement('div')
      empty.className = `${PANEL_ID}-workspace-empty`
      empty.textContent = 'No tags yet.'
      tagList.appendChild(empty)
    }
    tagWrap.appendChild(tagList)
    tagWrap.appendChild(this.makeTagAddRow())
    section.appendChild(tagWrap)

    const linksWrap = document.createElement('div')
    linksWrap.className = `${PANEL_ID}-workspace-group`
    linksWrap.appendChild(this.makeWorkspaceLabel('Links'))
    if (!this.panelDraft.items.length) {
      const empty = document.createElement('div')
      empty.className = `${PANEL_ID}-workspace-empty`
      empty.textContent = 'No related links in the block yet.'
      linksWrap.appendChild(empty)
    } else {
      const list = document.createElement('div')
      list.className = `${PANEL_ID}-list`
      for (const [index, item] of this.panelDraft.items.entries()) {
        list.appendChild(this.renderDraftLinkCard(item, index, currentFile))
      }
      linksWrap.appendChild(list)
    }
    section.appendChild(linksWrap)
    return section
  }

  private renderSuggestionsWorkspaceSection(
    note: GraphNote | null,
    graph: GraphFile | null,
    currentFile: string,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = `${PANEL_ID}-section`
    section.appendChild(this.makeSectionHeading('Suggestions', note?.related?.length || 0))

    const helper = document.createElement('div')
    helper.className = `${PANEL_ID}-workspace-helper`
    helper.textContent = 'Graph suggestions are optional. Add what helps, ignore what does not.'
    section.appendChild(helper)

    if (!graph) {
      const empty = document.createElement('div')
      empty.className = `${PANEL_ID}-workspace-empty`
      empty.textContent = `Suggestions unavailable until ${GRAPH_DIR}/${GRAPH_FILE} exists.`
      section.appendChild(empty)
      return section
    }

    if (!note) {
      const empty = document.createElement('div')
      empty.className = `${PANEL_ID}-workspace-empty`
      empty.textContent = 'This note is not indexed yet. Save the block and refresh suggestions when ready.'
      section.appendChild(empty)
      return section
    }

    if (!note.related?.length) {
      const empty = document.createElement('div')
      empty.className = `${PANEL_ID}-workspace-empty`
      empty.textContent = 'No graph suggestions for this note yet.'
      section.appendChild(empty)
      return section
    }

    const list = document.createElement('div')
    list.className = `${PANEL_ID}-list`
    const sectionKey = `${this.currentPanelNoteRelPath}:workspace-suggestions`
    const expanded = this.expandedPanelSections.has(sectionKey)
    const visible = expanded ? note.related : note.related.slice(0, PANEL_COLLAPSE_LIMIT)
    for (const item of visible) {
      list.appendChild(this.renderSuggestionCard(item, currentFile))
    }
    if (note.related.length > PANEL_COLLAPSE_LIMIT) {
      list.appendChild(this.makePanelSectionToggle(sectionKey, expanded, note.related.length))
    }
    section.appendChild(list)
    return section
  }

  private renderSourceWorkspace(): HTMLElement {
    const section = document.createElement('section')
    section.className = `${PANEL_ID}-section`
    section.appendChild(this.makeSectionHeading('Source', 0))

    const helper = document.createElement('div')
    helper.className = `${PANEL_ID}-workspace-helper`
    helper.textContent = 'Edit the relationship block directly. Visual mode and Source mode edit the same object.'
    section.appendChild(helper)

    const info = document.createElement('div')
    info.className = `${PANEL_ID}-editor-info`
    info.textContent = this.panelDraftDirty
      ? 'Unsaved changes in source mode.'
      : 'Source is in sync with the document.'
    section.appendChild(info)
    this.editorInfoEl = info

    const textarea = document.createElement('textarea')
    textarea.className = `${PANEL_ID}-editor-textarea`
    textarea.value = this.panelSourceDraft
    textarea.spellcheck = false
    textarea.addEventListener('input', () => {
      this.panelSourceDraft = textarea.value
      this.panelDraftDirty = true
      this.setEditorStatus('Unsaved source changes.')
      this.setPanelSaveState(false)
    })
    this.editorTextarea = textarea
    section.appendChild(textarea)
    window.setTimeout(() => {
      if (this.panelMode === 'source' && this.editorTextarea === textarea) {
        textarea.focus()
      }
    }, 20)
    return section
  }

  private makeWorkspaceLabel(label: string): HTMLElement {
    const el = document.createElement('div')
    el.className = `${PANEL_ID}-workspace-label`
    el.textContent = label
    return el
  }

  private makeTagAddRow(): HTMLElement {
    const row = document.createElement('div')
    row.className = `${PANEL_ID}-input-row`
    const input = document.createElement('input')
    input.className = `${PANEL_ID}-input`
    input.type = 'text'
    input.placeholder = 'Add tag'
    const add = this.makeButton('Add Tag', () => {
      this.addDraftTag(input.value)
      input.value = ''
    }, { variant: 'quiet' })
    input.addEventListener('keydown', evt => {
      if (evt.key === 'Enter') {
        evt.preventDefault()
        this.addDraftTag(input.value)
        input.value = ''
      }
    })
    row.appendChild(input)
    row.appendChild(add)
    return row
  }

  private makeEditableTagChip(tag: string): HTMLElement {
    const chip = document.createElement('div')
    chip.className = `${PANEL_ID}-editable-tag`
    const label = document.createElement('span')
    label.textContent = `#${tag}`
    const remove = this.makeButton('Remove', () => this.removeDraftTag(tag), { variant: 'quiet' })
    remove.classList.add(`${PANEL_ID}-chip-btn`)
    chip.appendChild(label)
    chip.appendChild(remove)
    return chip
  }

  private renderDraftLinkCard(item: InlineRelatedNote, index: number, currentFile: string): HTMLElement {
    const card = document.createElement('div')
    card.className = `${PANEL_ID}-card`
    card.title = this.buildInlineCardTooltip(item, currentFile)

    const top = document.createElement('div')
    top.className = `${PANEL_ID}-row-top`

    const main = document.createElement('div')
    main.className = `${PANEL_ID}-row-main`

    const title = document.createElement('div')
    title.className = `${PANEL_ID}-row-title`
    title.textContent = item.displayTitle
    const path = document.createElement('div')
    path.className = `${PANEL_ID}-row-path`
    path.textContent = item.pathLabel
    main.appendChild(title)
    main.appendChild(path)

    if (item.badges.length) {
      const meta = document.createElement('div')
      meta.className = `${PANEL_ID}-row-meta`
      for (const badge of item.badges.slice(0, 4)) {
        meta.appendChild(this.makeBadge(badge))
      }
      main.appendChild(meta)
    }

    const actions = document.createElement('div')
    actions.className = `${PANEL_ID}-row-actions`
    actions.appendChild(this.makeButton('Open', () => void this.openInlineWikiTarget(item.rawTarget, currentFile), { variant: 'quiet' }))
    actions.appendChild(this.makeButton('Remove', () => this.removeDraftItem(index), { variant: 'quiet' }))

    top.appendChild(main)
    top.appendChild(actions)
    card.appendChild(top)
    return card
  }

  private renderSuggestionCard(item: RelatedItem, currentFile: string): HTMLElement {
    const suggestion = this.buildSuggestedInlineItem(item, currentFile)
    const card = document.createElement('div')
    card.className = `${PANEL_ID}-card`
    card.title = this.buildInlineCardTooltip(suggestion, currentFile)

    const top = document.createElement('div')
    top.className = `${PANEL_ID}-row-top`

    const main = document.createElement('div')
    main.className = `${PANEL_ID}-row-main`

    const title = document.createElement('div')
    title.className = `${PANEL_ID}-row-title`
    title.textContent = suggestion.displayTitle
    const path = document.createElement('div')
    path.className = `${PANEL_ID}-row-path`
    path.textContent = suggestion.pathLabel
    main.appendChild(title)
    main.appendChild(path)

    if (suggestion.badges.length) {
      const meta = document.createElement('div')
      meta.className = `${PANEL_ID}-row-meta`
      for (const badge of suggestion.badges.slice(0, 4)) {
        meta.appendChild(this.makeBadge(badge))
      }
      main.appendChild(meta)
    }

    const actions = document.createElement('div')
    actions.className = `${PANEL_ID}-row-actions`
    actions.appendChild(this.makeButton('Open', () => void this.openInlineWikiTarget(suggestion.rawTarget, currentFile), { variant: 'quiet' }))
    const alreadyAdded = this.hasDraftItem(suggestion.rawTarget)
    const add = this.makeButton(alreadyAdded ? 'Added' : 'Add', () => this.addDraftItem(suggestion), {
      variant: alreadyAdded ? 'quiet' : 'primary',
    })
    add.disabled = alreadyAdded
    actions.appendChild(add)

    top.appendChild(main)
    top.appendChild(actions)
    card.appendChild(top)
    return card
  }

  private buildSuggestedInlineItem(item: RelatedItem, currentFile: string): InlineRelatedNote {
    const currentDir = normalizePath(platform.path.dirname(currentFile))
    const root = this.graphRoot || this.getFallbackRootDir()
    const absTarget = platform.path.join(root, item.relPath)
    const relative = withoutMarkdownExt(relPathFromDir(absTarget, currentDir))
    const note = this.noteMap.get(item.relPath)
    return {
      rawTarget: relative,
      displayTitle: item.title,
      pathLabel: item.relPath,
      reasonText: item.reasons.sharedTerms?.join(', ') || '',
      badges: this.collectPanelBadges(note, item),
    }
  }

  private hasDraftItem(rawTarget: string): boolean {
    const normalized = withoutMarkdownExt(rawTarget.split('#')[0].trim())
    return this.panelDraft.items.some(item => withoutMarkdownExt(item.rawTarget.split('#')[0].trim()) === normalized)
  }

  private addDraftTag(rawValue: string): void {
    const tag = rawValue.trim().replace(/^#/, '')
    if (!tag) return
    if (this.panelDraft.tags.includes(tag)) return
    this.panelDraft = this.normalizeParsedBlock({
      ...this.panelDraft,
      tags: [...this.panelDraft.tags, tag],
    })
    this.panelSourceDraft = this.composeNoteAssistantBlock(this.panelDraft)
    this.panelDraftDirty = true
    void this.renderCurrentNote()
  }

  private removeDraftTag(tag: string): void {
    this.panelDraft = this.normalizeParsedBlock({
      ...this.panelDraft,
      tags: this.panelDraft.tags.filter(item => item !== tag),
    })
    this.panelSourceDraft = this.composeNoteAssistantBlock(this.panelDraft)
    this.panelDraftDirty = true
    void this.renderCurrentNote()
  }

  private addDraftItem(item: InlineRelatedNote): void {
    if (this.hasDraftItem(item.rawTarget)) return
    this.panelDraft = this.normalizeParsedBlock({
      ...this.panelDraft,
      items: [...this.panelDraft.items, item],
    })
    this.panelSourceDraft = this.composeNoteAssistantBlock(this.panelDraft)
    this.panelDraftDirty = true
    void this.renderCurrentNote()
  }

  private removeDraftItem(index: number): void {
    this.panelDraft = this.normalizeParsedBlock({
      ...this.panelDraft,
      items: this.panelDraft.items.filter((_, itemIndex) => itemIndex !== index),
    })
    this.panelSourceDraft = this.composeNoteAssistantBlock(this.panelDraft)
    this.panelDraftDirty = true
    void this.renderCurrentNote()
  }

  private setPanelFooterStatus(root: string, note: GraphNote | null, graph: GraphFile | null): void {
    if (!this.panelStatusEl) return
    const state = this.panelDraftDirty
      ? 'Unsaved changes'
      : this.panelHasExistingBlock
        ? 'Block ready'
        : 'No block yet'
    const graphState = graph
      ? note ? 'suggestions ready' : 'graph pending for this note'
      : 'graph unavailable'
    this.panelStatusEl.textContent = `${state} · ${graphState} · ${root}`
  }

  private setPanelSaveState(busy: boolean): void {
    this.setButtonState(this.panelCloseBtn, { disabled: busy })
    this.setButtonState(this.panelSaveBtn, { disabled: busy, busyLabel: busy ? 'Saving...' : undefined })
    this.setButtonState(this.panelSaveRefreshBtn, {
      disabled: busy,
      busyLabel: busy ? 'Refreshing...' : undefined,
    })
  }

  private renderMetaSection(note: GraphNote, graph: GraphFile): HTMLElement {
    const section = document.createElement('section')
    section.className = `${PANEL_ID}-section ${PANEL_ID}-hero`

    const main = document.createElement('div')
    main.className = `${PANEL_ID}-hero-main`

    const eyebrow = document.createElement('div')
    eyebrow.className = `${PANEL_ID}-hero-eyebrow`
    eyebrow.textContent = 'Current Note'

    const title = document.createElement('div')
    title.className = `${PANEL_ID}-hero-title`
    title.textContent = note.title

    const path = document.createElement('div')
    path.className = `${PANEL_ID}-hero-path`
    path.textContent = this.currentPanelNoteRelPath || note.relPath

    main.appendChild(eyebrow)
    main.appendChild(title)
    main.appendChild(path)

    if (note.tags?.length) {
      const tags = document.createElement('div')
      tags.className = `${PANEL_ID}-hero-tags`
      for (const tag of note.tags.slice(0, 8)) {
        tags.appendChild(this.makeBadge(`#${tag}`))
      }
      main.appendChild(tags)
    }

    const summary = document.createElement('div')
    summary.className = `${PANEL_ID}-hero-summary`
    summary.innerHTML = `
      <div><strong>Aliases</strong><span>${escapeHtml((note.aliases || []).join(', ') || 'none')}</span></div>
      <div><strong>Headings</strong><span>${escapeHtml((note.headings || []).slice(0, 4).join(' · ') || 'none')}</span></div>
      <div><strong>Schema</strong><span>${graph.schemaVersion}</span></div>
      <div><strong>Generated</strong><span>${escapeHtml(graph.generatedAt)}</span></div>
    `
    main.appendChild(summary)

    const stats = document.createElement('div')
    stats.className = `${PANEL_ID}-hero-stats`
    const statItems: Array<[string, number]> = [
      ['Related', note.related?.length || 0],
      ['Backlinks', note.backlinks?.length || 0],
      ['Explicit', note.explicitLinks?.length || 0],
      ['Indexed', graph.stats.totalNotes],
    ]
    for (const [label, value] of statItems) {
      const stat = document.createElement('div')
      stat.className = `${PANEL_ID}-hero-stat`
      stat.innerHTML = `<strong>${value}</strong><span>${escapeHtml(label)}</span>`
      stats.appendChild(stat)
    }

    section.appendChild(main)
    section.appendChild(stats)
    return section
  }

  private renderLinkSection(label: string, notes: GraphNote[], currentFile: string): HTMLElement {
    const section = document.createElement('section')
    section.className = `${PANEL_ID}-section`
    section.appendChild(this.makeSectionHeading(label, notes.length))

    if (!notes.length) {
      const empty = document.createElement('div')
      empty.className = `${PANEL_ID}-status`
      empty.textContent = `No ${label.toLowerCase()}.`
      section.appendChild(empty)
      return section
    }

    const list = document.createElement('div')
    list.className = `${PANEL_ID}-list`
    const sectionKey = `${this.currentPanelNoteRelPath}:${label.toLowerCase().replace(/\s+/g, '-')}`
    const expanded = this.expandedPanelSections.has(sectionKey)
    const visibleNotes = expanded ? notes : notes.slice(0, PANEL_COLLAPSE_LIMIT)

    for (const note of visibleNotes) {
      const item: RelatedItem = {
        relPath: note.relPath,
        title: note.title,
        score: 0,
        reasons: {},
      }
      list.appendChild(this.renderRelatedCard(item, currentFile, false))
    }

    if (notes.length > PANEL_COLLAPSE_LIMIT) {
      list.appendChild(this.makePanelSectionToggle(sectionKey, expanded, notes.length))
    }

    section.appendChild(list)
    return section
  }

  private renderRelatedSection(items: RelatedItem[], currentFile: string): HTMLElement {
    const section = document.createElement('section')
    section.className = `${PANEL_ID}-section`
    section.appendChild(this.makeSectionHeading('Suggested Connections', items.length))

    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = `${PANEL_ID}-status`
      empty.textContent = 'No related suggestions found for this note.'
      section.appendChild(empty)
      return section
    }

    const list = document.createElement('div')
    list.className = `${PANEL_ID}-list`
    const sectionKey = `${this.currentPanelNoteRelPath}:suggested`
    const expanded = this.expandedPanelSections.has(sectionKey)
    const visibleItems = expanded ? items : items.slice(0, PANEL_COLLAPSE_LIMIT)

    for (const item of visibleItems) {
      list.appendChild(this.renderRelatedCard(item, currentFile, true))
    }

    if (items.length > PANEL_COLLAPSE_LIMIT) {
      list.appendChild(this.makePanelSectionToggle(sectionKey, expanded, items.length))
    }

    section.appendChild(list)
    return section
  }

  private renderRelatedCard(item: RelatedItem, currentFile: string, selectable: boolean): HTMLElement {
    const currentDir = normalizePath(platform.path.dirname(currentFile))
    const root = this.graphRoot || this.getFallbackRootDir()
    const absTarget = platform.path.join(root, item.relPath)
    const relative = withoutMarkdownExt(relPathFromDir(absTarget, currentDir))
    const note = this.noteMap.get(item.relPath)
    const badges = this.collectPanelBadges(note, item)

    const card = document.createElement('div')
    card.className = `${PANEL_ID}-card`
    card.title = selectable
      ? `Insert: [[${relative}|${item.title}]]`
      : item.relPath

    const top = document.createElement('div')
    top.className = `${PANEL_ID}-row-top`

    if (selectable) {
      const check = document.createElement('input')
      check.className = `${PANEL_ID}-check`
      check.type = 'checkbox'
      check.checked = this.selectionMap.size < 3
      this.selectionMap.set(item.relPath, check)
      top.appendChild(check)
    }

    const main = document.createElement('div')
    main.className = `${PANEL_ID}-row-main`

    const title = document.createElement('div')
    title.className = `${PANEL_ID}-row-title`
    title.textContent = item.title

    const relPath = document.createElement('div')
    relPath.className = `${PANEL_ID}-row-path`
    relPath.textContent = item.relPath

    const meta = document.createElement('div')
    meta.className = `${PANEL_ID}-row-meta`
    for (const badge of badges) {
      meta.appendChild(this.makeBadge(badge))
    }

    main.appendChild(title)
    main.appendChild(relPath)
    if (meta.childElementCount) {
      main.appendChild(meta)
    }

    const actions = document.createElement('div')
    actions.className = `${PANEL_ID}-row-actions`
    actions.appendChild(this.makeButton('Open', () => void this.openNote(item.relPath), { variant: 'quiet' }))

    top.appendChild(main)
    top.appendChild(actions)
    card.appendChild(top)
    return card
  }

  private makeSectionHeading(label: string, count: number): HTMLElement {
    const header = document.createElement('div')
    header.className = `${PANEL_ID}-section-header`
    header.innerHTML = `
      <div class="${PANEL_ID}-section-title">${escapeHtml(label)}</div>
      <div class="${PANEL_ID}-section-count">${count}</div>
    `
    return header
  }

  private makePanelSectionToggle(sectionKey: string, expanded: boolean, total: number): HTMLButtonElement {
    const hiddenCount = Math.max(0, total - PANEL_COLLAPSE_LIMIT)
    const button = this.makeButton(
      expanded ? 'Collapse' : `Show ${hiddenCount} More`,
      () => {
        if (expanded) this.expandedPanelSections.delete(sectionKey)
        else this.expandedPanelSections.add(sectionKey)
        void this.renderCurrentNote()
      },
      { variant: 'quiet' },
    )
    button.classList.add(`${PANEL_ID}-section-toggle`)
    return button
  }

  private collectPanelBadges(note: GraphNote | undefined, item: RelatedItem): string[] {
    const values = [
      ...(note?.tags || []).slice(0, 3).map(tag => `#${tag}`),
      ...(item.reasons.sharedTerms || []).slice(0, 3),
      item.reasons.explicitLink ? 'explicit' : '',
      item.reasons.backlink ? 'backlink' : '',
      item.reasons.sameDirectory ? 'same dir' : '',
      item.reasons.sameTopLevel ? 'same top' : '',
    ].filter(Boolean)
    return [...new Set(values)].slice(0, 4)
  }

  private makeBadge(label: string): HTMLElement {
    const badge = document.createElement('span')
    badge.className = `${PANEL_ID}-badge`
    badge.textContent = label
    return badge
  }

  private async openNote(relPath: string): Promise<void> {
    const root = this.graphRoot || this.getFallbackRootDir()
    if (!root) return
    try {
      await editor.openFile(platform.path.join(root, relPath))
      await this.renderCurrentNote()
    } catch (err) {
      console.error('[tpl:note-assistant] openNote failed', err)
      this.showNotice('Failed to open note')
    }
  }

  private insertSelectedLinks(): void {
    const currentFile = editor.getFilePath()
    const root = this.graphRoot || this.getFallbackRootDir()
    if (!currentFile || !root) return

    const currentDir = normalizePath(platform.path.dirname(currentFile))
    const selected = [...this.selectionMap.entries()]
      .filter(([, input]) => input.checked)
      .map(([relPath]) => {
        const note = this.noteMap.get(relPath)
        if (!note) return null
        const relative = withoutMarkdownExt(
          relPathFromDir(platform.path.join(root, relPath), currentDir),
        )
        const related = this.graphCache
          ? this.noteMap.get(relPath)
          : null
        const reason = related?.title ? '' : ''
        return `- [[${relative}|${note.title}]]${reason}`
      })
      .filter(Boolean) as string[]

    if (!selected.length) {
      this.showNotice('No links selected')
      return
    }

    const markdown = editor.getMarkdown()
    if (!markdown) {
      this.showNotice('Cannot read document content')
      return
    }

    const relPath = relPathFromRoot(currentFile, root)
    const currentNote = this.noteMap.get(relPath)
    const tags = (currentNote?.tags || []).slice(0, 5)
    const lines = [
      BLOCK_START,
      '## Note Assistant',
      '',
    ]
    if (tags.length) {
      lines.push(`Tags: ${tags.map(tag => `#${tag}`).join(' ')}`, '')
    }
    lines.push('Related Notes:', ...selected, '', BLOCK_END, '')

    const next = replaceNoteAssistantBlock(markdown, lines.join('\n'))
    editor.setMarkdown(next)
    this.showNotice(`Updated block with ${selected.length} links`)
    window.setTimeout(() => this.scheduleProcess(), 60)
  }

  private reparseDocument(): void {
    const markdown = editor.getMarkdown()
    if (!markdown) {
      this.showNotice('Cannot read document content')
      return
    }
    editor.setMarkdown(markdown)
    this.showNotice('Current document reparsed')
    window.setTimeout(() => this.scheduleProcess(), 60)
  }

  private async rebuildGraph(options: {
    onStatus?: (message: string) => void
    quietNotice?: boolean
  } = {}): Promise<boolean> {
    if (this.rebuildInFlight) return false

    const located = await this.findUpwardsForFile(BUILD_SCRIPT)
    if (!located) {
      options.onStatus?.(`Missing ${BUILD_SCRIPT}`)
      if (!options.quietNotice) this.showNotice(`Missing ${BUILD_SCRIPT}`)
      return false
    }

    this.rebuildInFlight = true
    this.setPanelBusyState(true)
    options.onStatus?.('Running graph rebuild...')
    if (!options.quietNotice) this.showNotice('Rebuilding note graph...')
    try {
      const cmd = `node ${platform.shell.escape(located.absPath)} --root ${platform.shell.escape(located.root)}`
      await platform.shell.run(cmd, { cwd: located.root, timeout: 120_000 })
      options.onStatus?.('Reloading refreshed graph...')
      this.graphCache = null
      await this.renderCurrentNote(true)
      if (!options.quietNotice) this.showNotice('Graph rebuilt')
      return true
    } catch (err) {
      console.error('[tpl:note-assistant] rebuildGraph failed', err)
      options.onStatus?.('Graph rebuild failed')
      if (!options.quietNotice) this.showNotice('Graph rebuild failed')
      return false
    } finally {
      this.rebuildInFlight = false
      this.setPanelBusyState(false)
    }
  }

  private setFooter(root: string, detail: string): void {
    if (!this.footerEl) return
    this.footerEl.innerHTML = `<div>${escapeHtml(root)}</div><div>${escapeHtml(detail)}</div>`
  }

  private processNoteAssistantBlocks(root: HTMLElement): void {
    this.withObserverPaused(() => {
      this.clearNoteAssistantClasses(root)

      const blocks = Array.from(root.children).filter((node): node is HTMLElement => node instanceof HTMLElement)
      const comments = Array.from(root.querySelectorAll<HTMLElement>('.md-comment'))
      let hasBlock = false
      let renderedPanels = 0

      for (let index = 0; index < comments.length; index += 1) {
        const startComment = comments[index]
        if ((startComment.textContent || '').trim() !== BLOCK_START) continue

        const endComment = comments.slice(index + 1).find(el => (el.textContent || '').trim() === BLOCK_END)
        if (!endComment) continue

        const startBlock = getTopLevelBlock(startComment, root)
        const endBlock = getTopLevelBlock(endComment, root)
        if (!startBlock || !endBlock) continue

        const startIndex = blocks.indexOf(startBlock)
        const endIndex = blocks.indexOf(endBlock)
        if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) continue

        const key = startBlock.getAttribute('cid') || `note-assistant-${startIndex}`
        const sourceBlocks = blocks.slice(startIndex, endIndex + 1)

        hasBlock = true
        startComment.classList.add('tpl-note-assistant-comment')
        endComment.classList.add('tpl-note-assistant-comment')

        for (const block of sourceBlocks) {
          block.classList.add('tpl-note-assistant-source')
          block.dataset.tplNoteKey = key
          block.classList.add('tpl-note-assistant-source-hidden')
        }

        const currentFile = editor.getFilePath()
        const parsed = this.parseInlineBlock(sourceBlocks)
        const panel = this.renderInlineBlock(parsed, key, currentFile)
        endBlock.insertAdjacentElement('afterend', panel)
        renderedPanels += 1
      }

      root.classList.toggle('tpl-has-note-assistant-block', hasBlock)
      this.debugChannel('render', 'processed blocks', { hasBlock, renderedPanels, comments: comments.length })
    })
  }

  private clearNoteAssistantClasses(root: HTMLElement): void {
    root.querySelectorAll('.tpl-note-assistant-comment').forEach(el => {
      el.classList.remove('tpl-note-assistant-comment')
    })
    root.querySelectorAll('.tpl-note-assistant-inline').forEach(el => el.remove())
    root.querySelectorAll('.tpl-note-assistant-source, .tpl-note-assistant-block').forEach(el => {
      el.classList.remove(
        'tpl-note-assistant-source',
        'tpl-note-assistant-source-hidden',
        'tpl-note-assistant-block',
        'tpl-note-assistant-first',
        'tpl-note-assistant-last',
        'tpl-note-assistant-title',
        'tpl-note-assistant-tags',
        'tpl-note-assistant-related-label',
        'tpl-note-assistant-related-list',
      )
      delete (el as HTMLElement).dataset.tplNoteKey
    })
  }

  private parseInlineBlock(sourceBlocks: HTMLElement[]): ParsedInlineBlock {
    const title = sourceBlocks.find(block => block.matches('h1,h2,h3,h4,h5,h6'))?.textContent?.trim() || 'Note Assistant'
    const tagsText = sourceBlocks.find(block => isTagsParagraph(block))?.textContent || ''
    const tags = [...new Set((tagsText.match(/#([^\s#]+)/g) || []).map(item => item.slice(1)).filter(Boolean))]
    const listBlock = sourceBlocks.find(block => block.matches('ul,ol'))
    const items = listBlock
      ? Array.from(listBlock.children)
          .filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches('li'))
          .map(item => this.parseInlineRelatedNote(item.textContent || ''))
          .filter((item): item is InlineRelatedNote => !!item)
      : []
    return { title, tags, items }
  }

  private parseInlineRelatedNote(rawText: string): InlineRelatedNote | null {
    const text = rawText
      .replace(BLOCK_END, '')
      .replace(/\s+/g, ' ')
      .trim()

    const match = text.match(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\](?:\s*-\s*(.+))?$/)
    if (!match) return null

    const rawTarget = match[1].trim()
    const displayTitle = (match[2] || deriveTitleFromTarget(rawTarget)).trim()
    const reasonText = (match[3] || '').trim()
    const badges = [...new Set(
      reasonText
        .split(/\s*[|,]\s*/g)
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 4),
    )]

    return {
      rawTarget,
      displayTitle,
      pathLabel: rawTarget,
      reasonText,
      badges,
    }
  }

  private renderInlineBlock(data: ParsedInlineBlock, key: string, currentFile: string): HTMLElement {
    const panel = document.createElement('section')
    panel.className = 'tpl-note-assistant-inline'
    panel.setAttribute('contenteditable', 'false')
    const expanded = this.expandedInlineKeys.has(key)
    const visibleItems = expanded ? data.items : data.items.slice(0, INLINE_COLLAPSE_LIMIT)

    const header = document.createElement('div')
    header.className = 'tpl-note-assistant-inline-header'

    const titleWrap = document.createElement('div')
    titleWrap.className = 'tpl-note-assistant-inline-title-wrap'

    const title = document.createElement('div')
    title.className = 'tpl-note-assistant-inline-title'
    title.textContent = data.title

    const subtitle = document.createElement('div')
    subtitle.className = 'tpl-note-assistant-inline-subtitle'
    subtitle.textContent = data.items.length
      ? expanded || data.items.length <= INLINE_COLLAPSE_LIMIT
        ? `${data.items.length} related notes · click a card to open`
        : `${INLINE_COLLAPSE_LIMIT} of ${data.items.length} related notes shown`
      : 'No related notes yet'

    titleWrap.appendChild(title)
    titleWrap.appendChild(subtitle)

    const actions = document.createElement('div')
    actions.className = 'tpl-note-assistant-inline-actions'
    actions.appendChild(this.makeInlineButton('Manage', () => void this.openPanelMode('visual')))
    actions.appendChild(this.makeInlineButton('Source', () => this.openBlockEditor(key)))

    header.appendChild(titleWrap)
    header.appendChild(actions)
    panel.appendChild(header)

    if (data.tags.length) {
      const tags = document.createElement('div')
      tags.className = 'tpl-note-assistant-inline-tags'
      for (const tag of data.tags) {
        const chip = document.createElement('span')
        chip.className = 'tpl-note-assistant-inline-tag'
        chip.textContent = `#${tag}`
        tags.appendChild(chip)
      }
      panel.appendChild(tags)
    }

    const list = document.createElement('div')
    list.className = 'tpl-note-assistant-inline-list'
    if (!data.items.length) {
      const empty = document.createElement('div')
      empty.className = 'tpl-note-assistant-inline-empty'
      empty.textContent = 'No related notes available yet.'
      list.appendChild(empty)
    } else {
      for (const item of visibleItems) {
        list.appendChild(this.renderInlineRelatedCard(item, currentFile))
      }
      if (data.items.length > INLINE_COLLAPSE_LIMIT) {
        list.appendChild(this.makeInlineListToggle(key, expanded, data.items.length))
      }
    }
    panel.appendChild(list)
    return panel
  }

  private renderInlineRelatedCard(item: InlineRelatedNote, currentFile: string): HTMLElement {
    const button = document.createElement('button')
    button.className = 'tpl-note-assistant-inline-card'
    button.type = 'button'
    button.setAttribute('contenteditable', 'false')
    button.title = this.buildInlineCardTooltip(item, currentFile)
    button.addEventListener('mousedown', evt => {
      evt.preventDefault()
      evt.stopPropagation()
    })
    button.addEventListener('click', evt => {
      evt.preventDefault()
      evt.stopPropagation()
      this.logChannel('inline', 'card click', { target: item.rawTarget })
      void this.openInlineWikiTarget(item.rawTarget, currentFile)
    })

    const main = document.createElement('div')
    main.className = 'tpl-note-assistant-inline-card-main'

    const title = document.createElement('div')
    title.className = 'tpl-note-assistant-inline-card-title'
    title.textContent = item.displayTitle

    const path = document.createElement('div')
    path.className = 'tpl-note-assistant-inline-card-path'
    path.textContent = item.pathLabel

    main.appendChild(title)
    main.appendChild(path)

    if (item.badges.length) {
      const meta = document.createElement('div')
      meta.className = 'tpl-note-assistant-inline-card-meta'
      for (const badge of item.badges) {
        const chip = document.createElement('span')
        chip.className = 'tpl-note-assistant-inline-badge'
        chip.textContent = badge
        meta.appendChild(chip)
      }
      main.appendChild(meta)
    }

    const open = document.createElement('div')
    open.className = 'tpl-note-assistant-inline-open'
    open.textContent = 'Open'

    button.appendChild(main)
    button.appendChild(open)
    return button
  }

  private setButtonState(button: HTMLButtonElement | null, state: {
    disabled?: boolean
    busyLabel?: string
  } = {}): void {
    if (!button) return
    const originalLabel = button.dataset.label || button.textContent || ''
    button.disabled = !!state.disabled
    button.textContent = state.busyLabel || originalLabel
  }

  private setPanelBusyState(busy: boolean): void {
    this.setButtonState(this.panelRefreshBtn, { disabled: busy, busyLabel: busy ? 'Refreshing...' : undefined })
    this.setPanelSaveState(busy)
  }

  private setEditorStatus(message: string): void {
    if (this.editorInfoEl) {
      this.editorInfoEl.textContent = message
    }
  }

  private setEditorBusyState(mode: 'idle' | 'saving' | 'rebuilding'): void {
    const disabled = mode !== 'idle'
    this.setPanelSaveState(disabled)
    if (this.editorTextarea) {
      this.editorTextarea.disabled = disabled
    }
  }

  private makeInlineListToggle(key: string, expanded: boolean, total: number): HTMLButtonElement {
    const hiddenCount = Math.max(0, total - INLINE_COLLAPSE_LIMIT)
    const button = this.makeInlineButton(
      expanded ? 'Collapse' : `Show ${hiddenCount} More`,
      () => {
        if (expanded) this.expandedInlineKeys.delete(key)
        else this.expandedInlineKeys.add(key)
        this.scheduleProcess()
      },
    )
    button.classList.add('tpl-note-assistant-inline-toggle')
    return button
  }

  private buildInlineCardTooltip(item: InlineRelatedNote, currentFile: string): string {
    const resolution = this.buildInlineTargetResolution(item.rawTarget, currentFile)
    const lines = [
      `${item.displayTitle}`,
      `target: ${item.rawTarget}`,
    ]

    if (item.reasonText) {
      lines.push(`reason: ${item.reasonText}`)
    }

    if (resolution.candidates.length) {
      lines.push('', 'Candidates:')
      for (const candidate of resolution.candidates.slice(0, 8)) {
        lines.push(candidate)
      }
      if (resolution.candidates.length > 8) {
        lines.push(`... +${resolution.candidates.length - 8} more`)
      }
    }

    return lines.join('\n')
  }

  private makeInlineButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'tpl-note-assistant-inline-btn'
    button.type = 'button'
    button.textContent = label
    button.setAttribute('contenteditable', 'false')
    button.addEventListener('mousedown', evt => {
      evt.preventDefault()
      evt.stopPropagation()
    })
    button.addEventListener('click', evt => {
      evt.preventDefault()
      evt.stopPropagation()
      this.logChannel('inline', 'button click', { label })
      onClick()
    })
    return button
  }

  private openBlockEditor(key = ''): void {
    const initialMarkdown = this.overlay
      ? this.composeNoteAssistantBlock(this.panelDraft)
      : this.getEditableBlockMarkdown(key)
    this.logChannel('inline', 'open source mode', { key, hasExistingBlock: !!initialMarkdown.trim() })
    this.panelMode = 'source'
    this.panelSourceDraft = initialMarkdown
    this.panelDraft = this.normalizeParsedBlock(this.parseBlockMarkdown(initialMarkdown))
    this.panelDraftDirty = false
    if (!this.overlay) {
      void this.openPanelMode('source')
      return
    }
    void this.renderCurrentNote()
  }

  private closeBlockEditor(): void {
    this.editorOverlay = null
    this.editorTextarea = null
    this.editorInfoEl = null
    this.editorCancelBtn = null
    this.editorSaveBtn = null
    this.editorSaveRefreshBtn = null
    this.editorSaveInFlight = false
  }

  private getEditableBlockMarkdown(key = ''): string {
    if (key && this.writeEl) {
      const sourceBlocks = Array.from(
        this.writeEl.querySelectorAll<HTMLElement>(`.tpl-note-assistant-source[data-tpl-note-key="${key}"]`),
      )
      if (sourceBlocks.length) {
        const parsed = this.parseInlineBlock(sourceBlocks)
        return this.composeNoteAssistantBlock(parsed)
      }
    }

    const markdown = editor.getMarkdown() || ''
    const existing = markdown.match(/<!-- note-assistant:start -->[\s\S]*?<!-- note-assistant:end -->/)
    if (existing?.[0]) return existing[0].trim()

    return this.buildDefaultBlockMarkdown()
  }

  private buildDefaultBlockMarkdown(): string {
    const currentFile = editor.getFilePath()
    const root = this.graphRoot || this.getFallbackRootDir()
    const relPath = currentFile && root ? relPathFromRoot(currentFile, root) : ''
    const note = relPath ? this.noteMap.get(relPath) : null
    return this.composeNoteAssistantBlock({
      title: 'Note Assistant',
      tags: (note?.tags || []).slice(0, 5),
      items: [],
    })
  }

  private composeNoteAssistantBlock(data: ParsedInlineBlock): string {
    const lines = [
      BLOCK_START,
      `## ${data.title || 'Note Assistant'}`,
      '',
    ]

    if (data.tags.length) {
      lines.push(`Tags: ${data.tags.map(tag => `#${tag}`).join(' ')}`, '')
    }

    lines.push('Related Notes:')

    for (const item of data.items) {
      const link = `[[${item.rawTarget}|${item.displayTitle}]]`
      lines.push(item.reasonText ? `- ${link} - ${item.reasonText}` : `- ${link}`)
    }

    lines.push('', BLOCK_END)
    return lines.join('\n')
  }

  private normalizeEditedBlockMarkdown(rawMarkdown: string): string {
    let text = rawMarkdown.replace(/\r\n/g, '\n').trim()
    if (!text) {
      return this.buildDefaultBlockMarkdown()
    }
    if (!text.includes(BLOCK_START)) {
      text = `${BLOCK_START}\n${text}`
    }
    if (!text.includes(BLOCK_END)) {
      text = `${text}\n${BLOCK_END}`
    }
    return text
  }

  private async saveBlockEditor(rebuildGraphAfterSave: boolean): Promise<void> {
    if (this.editorSaveInFlight) return

    this.editorSaveInFlight = true
    this.setEditorBusyState(rebuildGraphAfterSave ? 'rebuilding' : 'saving')
    this.setEditorStatus(
      rebuildGraphAfterSave
        ? 'Saving block before refreshing graph index...'
        : 'Saving note assistant block...',
    )

    const markdown = editor.getMarkdown()
    if (!markdown) {
      this.setEditorStatus('Cannot read current document content.')
      this.showNotice('Cannot read document content')
      this.setEditorBusyState('idle')
      this.editorSaveInFlight = false
      return
    }

    const rawBlock = this.panelMode === 'source'
      ? this.panelSourceDraft
      : this.composeNoteAssistantBlock(this.panelDraft)
    const normalizedBlock = this.normalizeEditedBlockMarkdown(rawBlock)
    this.panelDraft = this.normalizeParsedBlock(this.parseBlockMarkdown(normalizedBlock))
    this.panelSourceDraft = normalizedBlock
    this.panelHasExistingBlock = true
    this.panelLoadedBlockMarkdown = normalizedBlock
    this.panelDraftDirty = false
    this.logChannel('inline', 'save block editor', {
      rebuildGraphAfterSave,
      blockLength: normalizedBlock.length,
    })
    const next = replaceNoteAssistantBlock(markdown, normalizedBlock)
    editor.setMarkdown(next)
    window.setTimeout(() => this.scheduleProcess(), 60)
    window.setTimeout(() => {
      void this.renderCurrentNote(true)
    }, 80)

    if (!rebuildGraphAfterSave) {
      this.showNotice('Saved note assistant block')
      this.setEditorStatus('Saved note assistant block.')
      this.setEditorBusyState('idle')
      this.editorSaveInFlight = false
      void this.renderCurrentNote(true)
      return
    }

    this.showNotice('Saved block, waiting to rebuild graph...')
    this.setEditorStatus('Block saved. Waiting for Typora to flush file to disk...')

    try {
      await new Promise(resolve => window.setTimeout(resolve, 500))
      const rebuilt = await this.rebuildGraph({
        quietNotice: true,
        onStatus: message => this.setEditorStatus(message),
      })
      if (rebuilt) {
        this.showNotice('Saved block and refreshed graph')
        this.setEditorStatus('Graph refreshed successfully.')
        void this.renderCurrentNote(true)
        return
      }
      this.showNotice('Block saved, but graph refresh failed')
      this.setEditorStatus('Block saved, but graph refresh failed. You can retry now.')
    } finally {
      this.setEditorBusyState('idle')
      this.editorSaveInFlight = false
    }
  }

  private async openInlineWikiTarget(rawTarget: string, currentFile: string): Promise<void> {
    const resolution = this.buildInlineTargetResolution(rawTarget, currentFile)
    if (!resolution.normalizedTarget) return

    this.debugChannel('navigation', 'resolve inline target', {
      rawTarget,
      currentFile,
      candidates: resolution.candidates,
    })

    for (const candidate of resolution.candidates) {
      if (await platform.fs.exists(candidate)) {
        try {
          this.logChannel('navigation', 'open inline target resolved', { rawTarget, candidate })
          await editor.openFile(candidate)
          await this.renderCurrentNote()
          return
        } catch (err) {
          console.error('[tpl:note-assistant] openInlineWikiTarget failed', err)
        }
      }
    }

    this.showNotice('Failed to resolve related note path')
    this.warnChannel('navigation', 'failed to resolve inline target', {
      rawTarget,
      candidates: resolution.candidates,
    })
  }

  private buildInlineTargetResolution(rawTarget: string, currentFile: string): InlineTargetResolution {
    const normalizedTarget = rawTarget.split('#')[0].trim()
    const candidates = new Set<string>()

    if (!normalizedTarget) {
      return { rawTarget, normalizedTarget, candidates: [] }
    }

    const currentDir = platform.path.dirname(currentFile)
    const resolved = platform.path.resolve(currentDir, normalizedTarget)
    candidates.add(resolved)
    if (!platform.path.extname(resolved)) {
      candidates.add(`${resolved}.md`)
      candidates.add(`${resolved}.markdown`)
    }

    const root = this.graphRoot || this.getFallbackRootDir()
    if (root && !platform.path.isAbsolute(normalizedTarget)) {
      const rootCandidate = platform.path.resolve(root, normalizedTarget)
      candidates.add(rootCandidate)
      if (!platform.path.extname(rootCandidate)) {
        candidates.add(`${rootCandidate}.md`)
        candidates.add(`${rootCandidate}.markdown`)
      }
    }

    return {
      rawTarget,
      normalizedTarget,
      candidates: [...candidates],
    }
  }

  private connectObserver(): void {
    if (!this.observer || !this.writeEl || this.observerConnected) return
    this.observer.observe(this.writeEl, {
      childList: true,
      subtree: true,
    })
    this.observerConnected = true
  }

  private disconnectObserver(): void {
    if (!this.observerConnected) return
    this.observer?.disconnect()
    this.observerConnected = false
  }

  private withObserverPaused<T>(fn: () => T): T {
    this.disconnectObserver()
    try {
      return fn()
    } finally {
      this.connectObserver()
    }
  }

  private shouldIgnoreMutations(mutations: MutationRecord[]): boolean {
    return mutations.every(mutation => {
      const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)]
      return nodes.length > 0 && nodes.every(node => this.isOwnInlineNode(node))
    })
  }

  private isOwnInlineNode(node: Node): boolean {
    if (!(node instanceof HTMLElement)) return false
    return node.classList.contains('tpl-note-assistant-inline')
      || !!node.closest('.tpl-note-assistant-inline')
  }

  private log(message: string, data?: unknown): void {
    this.writeLog('core', 'info', message, data)
  }

  private debug(message: string, data?: unknown): void {
    this.writeLog('core', 'debug', message, data)
  }

  private warn(message: string, data?: unknown): void {
    this.writeLog('core', 'warn', message, data)
  }

  private logChannel(channel: string, message: string, data?: unknown): void {
    this.writeLog(channel, 'info', message, data)
  }

  private debugChannel(channel: string, message: string, data?: unknown): void {
    this.writeLog(channel, 'debug', message, data)
  }

  private warnChannel(channel: string, message: string, data?: unknown): void {
    this.writeLog(channel, 'warn', message, data)
  }

  private writeLog(channel: string, level: 'info' | 'debug' | 'warn', message: string, data?: unknown): void {
    const prefix = `[tpl:note-assistant:${channel}]`
    const logger = level === 'warn'
      ? console.warn
      : level === 'debug'
        ? console.debug
        : console.info

    if (data === undefined) {
      logger(prefix, message)
      return
    }
    logger(prefix, message, data)
  }
}

function isTagsParagraph(el: HTMLElement): boolean {
  return el.matches('p') && (el.textContent || '').trim().startsWith('Tags:')
}

function isRelatedLabel(el: HTMLElement): boolean {
  return el.matches('p') && (el.textContent || '').trim() === 'Related Notes:'
}

function extractNoteAssistantBlock(markdown: string): string | null {
  return markdown.match(/<!-- note-assistant:start -->[\s\S]*?<!-- note-assistant:end -->/)?.[0] || null
}

function replaceNoteAssistantBlock(markdown: string, section: string): string {
  const blockRe = /<!-- note-assistant:start -->[\s\S]*?<!-- note-assistant:end -->\n?/g
  if (blockRe.test(markdown)) {
    return markdown.replace(blockRe, `${section}\n`)
  }
  return `${markdown.replace(/\s+$/u, '')}\n\n${section}`
}

function deriveTitleFromTarget(rawTarget: string): string {
  const withoutHeading = rawTarget.split('#')[0]
  const base = withoutMarkdownExt(withoutHeading)
  const name = normalizePath(base).split('/').filter(Boolean).pop() || base
  return name.replace(/[_-]+/g, ' ').trim() || name
}

function getTopLevelBlock(node: Node, root: HTMLElement): HTMLElement | null {
  let current: Node | null = node
  while (current && current.parentNode && current.parentNode !== root) {
    current = current.parentNode
  }
  return current instanceof HTMLElement ? current : null
}
