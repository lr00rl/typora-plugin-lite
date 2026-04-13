interface RectLike {
  top: number
  right: number
}

interface PortalMetrics {
  reserve: number
  offset: number
  width: number
}

interface ScrollOffsets {
  scrollX: number
  scrollY: number
}

export function getPortalPagePosition(
  anchorRect: RectLike,
  writeRect: Pick<RectLike, 'right'>,
  metrics: PortalMetrics,
  scroll: ScrollOffsets,
): { top: number, left: number } {
  return {
    top: anchorRect.top + scroll.scrollY,
    left: writeRect.right + scroll.scrollX - (metrics.reserve - metrics.offset) - metrics.width,
  }
}
