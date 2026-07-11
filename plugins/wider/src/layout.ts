export type WiderMode = 'default' | 'wide' | 'full'

export interface WiderLayoutInput {
  mode: WiderMode
  viewportWidth: number
  sidenoteReserve: number
}

export interface WiderLayout {
  shellGutter: number
  contentWidth: number
  maxWidth: number
}

const DEFAULT_CONTENT_WIDTH = 860
const WIDE_MIN_CONTENT_WIDTH = 1000
const WIDE_MAX_CONTENT_WIDTH = 1180
const WIDE_AVAILABLE_RATIO = 0.78
const FULL_MAX_CONTENT_WIDTH = 1680
const MIN_CONTENT_WIDTH = 560

/**
 * Resolve the three editor widths against the actual window rather than a
 * device label. Default remains a focused reading column, Wide scales within
 * a bounded technical-document range, and Full consumes remaining space up
 * to a desktop-safe cap. Sidenotes occupy shell width, never prose width.
 */
export function calculateWiderLayout(input: WiderLayoutInput): WiderLayout {
  const viewportWidth = Math.max(0, input.viewportWidth)
  const sidenoteReserve = Math.max(0, input.sidenoteReserve)
  const shellGutter = calcViewportGutter(viewportWidth)
  const availableShellWidth = Math.max(0, viewportWidth - (shellGutter * 2))
  const availableContentWidth = Math.max(0, availableShellWidth - sidenoteReserve)
  const safeContentFloor = Math.min(MIN_CONTENT_WIDTH, availableContentWidth)

  let desiredContentWidth = DEFAULT_CONTENT_WIDTH
  if (input.mode === 'wide') {
    desiredContentWidth = clamp(
      Math.round(availableContentWidth * WIDE_AVAILABLE_RATIO),
      WIDE_MIN_CONTENT_WIDTH,
      WIDE_MAX_CONTENT_WIDTH,
    )
  } else if (input.mode === 'full') {
    desiredContentWidth = Math.min(
      FULL_MAX_CONTENT_WIDTH,
      Math.max(WIDE_MIN_CONTENT_WIDTH, availableContentWidth),
    )
  }

  const maxWidth = Math.max(
    safeContentFloor + sidenoteReserve,
    Math.min(availableShellWidth, desiredContentWidth + sidenoteReserve),
  )
  const contentWidth = Math.max(safeContentFloor, maxWidth - sidenoteReserve)

  return {
    shellGutter,
    contentWidth,
    maxWidth,
  }
}

function calcViewportGutter(viewportWidth: number): number {
  if (viewportWidth < 1024) return 16
  return clamp(Math.round(viewportWidth * 0.04), 24, 72)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
