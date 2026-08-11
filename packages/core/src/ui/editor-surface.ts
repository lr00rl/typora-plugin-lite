/** Geometry shared by editor plugins that must respect Typora's visible host. */

export function calculateEditorShellGutter(hostWidth: number): number {
  const width = Math.max(0, hostWidth)
  if (width < 1024) return 16
  return clamp(Math.round(width * 0.04), 24, 72)
}

export function canFitEditorReserve(
  hostWidth: number,
  reserve: number,
  minimumProseWidth: number,
): boolean {
  const width = Math.max(0, hostWidth)
  const required = Math.max(0, reserve) + Math.max(0, minimumProseWidth)
  return width - (calculateEditorShellGutter(width) * 2) >= required
}

export function getEditorHost(writeEl: HTMLElement): HTMLElement {
  return writeEl.parentElement ?? writeEl
}

/** Resolve the visible #write when Typora briefly retains duplicate nodes. */
export function findActiveWritingArea(scope: ParentNode = document): HTMLElement | null {
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>('#write'))
  let active: HTMLElement | null = null
  let largestArea = 0

  for (const candidate of candidates) {
    if (!candidate.isConnected) continue
    const style = getComputedStyle(candidate)
    if (style.display === 'none' || style.visibility === 'hidden') continue

    const rect = candidate.getBoundingClientRect()
    const area = Math.max(0, rect.width) * Math.max(0, rect.height)
    if (area <= largestArea) continue
    active = candidate
    largestArea = area
  }

  return active ?? candidates.find(candidate => candidate.isConnected) ?? null
}

export function measureVisibleEditorHostWidth(writeEl: HTMLElement): number {
  const host = getEditorHost(writeEl)
  const rectWidth = host.getBoundingClientRect().width
  const clientWidth = host.clientWidth
  const positiveWidths = [rectWidth, clientWidth]
    .filter(width => Number.isFinite(width) && width > 0)
  if (positiveWidths.length > 0) return Math.min(...positiveWidths)

  const writeWidth = writeEl.getBoundingClientRect().width
  return Number.isFinite(writeWidth) ? Math.max(0, writeWidth) : 0
}

export function observeEditorHostResize(
  writeEl: HTMLElement,
  callback: () => void,
): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}

  const observer = new ResizeObserver(() => callback())
  observer.observe(getEditorHost(writeEl))
  return () => observer.disconnect()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
