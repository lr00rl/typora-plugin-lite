import {
  calculateEditorShellGutter,
  canFitEditorReserve,
} from '../../../packages/core/src/ui/editor-surface.js'

export type WiderMode = 'default' | 'wide' | 'full'

export interface WiderLayoutInput {
  mode: WiderMode
  hostWidth: number
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
 * Resolve the three editor widths against the visible editor host rather than a
 * device label. Default remains a focused reading column, Wide scales within
 * a bounded technical-document range, and Full consumes remaining space up
 * to a desktop-safe cap. Sidenotes occupy shell width, never prose width.
 */
export function calculateWiderLayout(input: WiderLayoutInput): WiderLayout {
  const hostWidth = Math.max(0, input.hostWidth)
  const requestedReserve = Math.max(0, input.sidenoteReserve)
  const sidenoteReserve = canFitEditorReserve(hostWidth, requestedReserve, DEFAULT_CONTENT_WIDTH)
    ? requestedReserve
    : 0
  const shellGutter = calculateEditorShellGutter(hostWidth)
  const availableShellWidth = Math.max(0, hostWidth - (shellGutter * 2))
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
