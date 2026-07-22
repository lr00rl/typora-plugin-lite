/**
 * Shared building blocks for rendering code: vim-listchars-style whitespace
 * markers and VS Code-style indent guides.
 *
 * Pure functions + a CSS fragment, consumed by:
 *   - plugins/code-viewer  — its own read-only DOM (full treatment)
 *   - plugins/fence-enhance — Typora's CodeMirror fences (STYLE-ONLY: CM's
 *     lineView caches text-node references, so injecting spans into a fence
 *     would break cursor measurement; backgrounds and ::before overlays are
 *     the only safe mutations there)
 *
 * The golden rule everywhere: the text itself is never altered. Markers are
 * spans/backgrounds/pseudo-elements around the original characters, so copy,
 * selection and measurement all see the untouched source.
 */

export interface WsChunk {
  text: string
  kind: 'text' | 'space' | 'tab'
}

/**
 * Split a line into maximal runs of spaces, runs of tabs, and text. Renderers
 * wrap the whitespace runs in marker spans; text runs keep their token class.
 */
export function splitWhitespace(text: string): WsChunk[] {
  const chunks: WsChunk[] = []
  let kind: WsChunk['kind'] | null = null
  let start = 0
  const kindOf = (ch: string): WsChunk['kind'] => (ch === ' ' ? 'space' : ch === '\t' ? 'tab' : 'text')
  for (let i = 0; i < text.length; i++) {
    const k = kindOf(text[i]!)
    if (k !== kind) {
      if (kind !== null) chunks.push({ text: text.slice(start, i), kind })
      kind = k
      start = i
    }
  }
  if (kind !== null) chunks.push({ text: text.slice(start), kind })
  return chunks
}

/** Effective indentation width of a line in columns (tabs expand to tab stops). */
export function indentColumns(line: string, tabSize: number): number {
  let col = 0
  for (const ch of line) {
    if (ch === ' ') col += 1
    else if (ch === '\t') col += tabSize - (col % tabSize)
    else break
  }
  return col
}

/** Guide positions for a line: every tab stop up to and including its indent. */
export function indentGuideColumns(line: string, tabSize: number): number[] {
  const col = indentColumns(line, tabSize)
  const guides: number[] = []
  for (let g = tabSize; g <= col; g += tabSize) guides.push(g)
  return guides
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/**
 * The indent unit of a file: 2 for `··fn` style code, 4 for classic, tabSize
 * for tab-indented or undetectable content. Detection is the GCD of the
 * nonzero indents of up to `maxSample` content lines, so a 2-space file gets
 * guides at 2ch, 4ch, 6ch… instead of every other level at 4ch, 8ch.
 * Whitespace-only lines are excluded (a stray 1-space blank line must not
 * poison the GCD). Tab-led lines vote by majority rather than hijacking the
 * result: they only force tabSize when they outnumber space-led indented
 * lines, so one stray tab in a 2-space file changes nothing.
 */
export function detectIndentUnit(lines: readonly string[], tabSize: number, maxSample = 200): number {
  let unit = 0
  let sampled = 0
  let tabLed = 0
  let spaceLed = 0
  for (const line of lines) {
    if (sampled >= maxSample) break
    if (line.length === 0 || line.trim() === '') continue
    sampled += 1
    if (line[0] === '\t') { tabLed += 1; continue }
    const cols = indentColumns(line, tabSize)
    if (cols === 0) continue
    spaceLed += 1
    unit = unit === 0 ? cols : gcd(unit, cols)
  }
  if (tabLed > spaceLed) return tabSize
  return spaceLed === 0 || unit < 2 ? tabSize : unit
}

/**
 * Guide columns for every line of a file at once, with VS Code-style blank
 * line continuation: an empty line inherits the guides of the surrounding
 * block (the smaller indent of the nearest non-empty lines above and below),
 * so guides don't visually break inside an indented block.
 *
 * `unit` comes from detectIndentUnit(); guide positions are multiples of it.
 */
export function guideColumnsPerLine(
  lines: readonly string[],
  tabSize: number,
  unit: number,
): number[][] {
  const indents = lines.map(line => (line.length === 0 ? -1 : indentColumns(line, tabSize)))
  return indents.map((rawCols, i) => {
    let cols = rawCols
    if (cols === -1) {
      let prev = 0
      for (let j = i - 1; j >= 0; j--) {
        if (indents[j] !== -1) { prev = indents[j]!; break }
      }
      let next = 0
      for (let j = i + 1; j < indents.length; j++) {
        if (indents[j] !== -1) { next = indents[j]!; break }
      }
      cols = prev === 0 ? next : next === 0 ? prev : Math.min(prev, next)
    }
    const guides: number[] = []
    for (let g = unit; g <= cols; g += unit) guides.push(g)
    return guides
  })
}

/**
 * A background-image painting 1px vertical rules at the given ch columns.
 * Apply with `background-repeat: no-repeat` and the returned size, so no rule
 * shows past the line's own indent (and none at column 0). Lines sit exactly
 * on character boundaries of the monospace grid — between glyphs, never over
 * them — which is what makes indent guides readable instead of noisy.
 */
export function indentGuideBackground(
  guides: readonly number[],
  color: string,
): { image: string; size: string } | null {
  if (guides.length === 0) return null
  const stops: string[] = []
  let prev = '0ch'
  for (const g of guides) {
    stops.push(`transparent ${prev}`)
    stops.push(`transparent calc(${g}ch - 1px)`)
    stops.push(`${color} calc(${g}ch - 1px)`)
    stops.push(`${color} ${g}ch`)
    prev = `${g}ch`
  }
  stops.push(`transparent ${prev}`)
  const last = guides[guides.length - 1]!
  return {
    image: `linear-gradient(90deg, ${stops.join(', ')})`,
    size: `${last}ch 100%`,
  }
}

/**
 * Whitespace-marker styles, shared verbatim by both consumers so the pane and
 * fences look identical. Marker color is the `--tpl-ws-color` custom property.
 *
 *   .tpl-ws-sp   one span per maximal space run; the spaces stay in the DOM
 *                (copy yields real spaces) but are transparent, with a dot
 *                tiled at each 1ch cell via background.
 *   .tpl-ws-tab  one span per tab run; the tab char still advances the layout
 *                (transparent), a » is overlaid at its start.
 */
export const CODEBLOCK_MARKER_CSS = `
.tpl-ws-sp {
  color: transparent;
  background-image: radial-gradient(circle at 50% 50%, var(--tpl-ws-color, rgba(128,128,128,0.55)) 0.08em, transparent 0.1em);
  background-size: 1ch 100%;
  background-repeat: repeat-x;
}
.tpl-ws-tab {
  position: relative;
  color: transparent;
}
.tpl-ws-tab::before {
  content: '»';
  position: absolute;
  left: 0;
  color: var(--tpl-ws-color, rgba(128,128,128,0.55));
}
`
