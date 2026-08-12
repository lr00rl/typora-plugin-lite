export type TextWidthMeasure = (value: string) => number

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function compactHomePath(path: string): string {
  const normalized = normalizePath(path)
  return normalized
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/i, '~')
}

/**
 * Convert a file path to the directory label shown beside its basename.
 * Keeping the trailing slash makes every visible token an intact directory
 * segment and avoids making the last directory look like a filename.
 */
export function directoryPathForDisplay(filePath: string): string {
  const normalized = normalizePath(filePath)
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash < 0) return '/'
  return compactHomePath(normalized.slice(0, lastSlash + 1)) || '/'
}

interface ParsedDirectoryPath {
  prefix: string
  segments: string[]
}

function parseDirectoryPath(path: string): ParsedDirectoryPath {
  let normalized = normalizePath(path)
  let prefix = ''
  const drive = normalized.match(/^[A-Za-z]:\//)
  const unc = normalized.match(/^\/\/[^/]+\/[^/]+\//)
  const relative = normalized.match(/^(?:\.{1,2}\/)+/)
  if (unc) {
    prefix = unc[0]
    normalized = normalized.slice(prefix.length)
  } else if (drive) {
    prefix = drive[0]
    normalized = normalized.slice(prefix.length)
  } else if (normalized.startsWith('~/')) {
    prefix = '~/'
    normalized = normalized.slice(2)
  } else if (normalized.startsWith('/')) {
    prefix = '/'
    normalized = normalized.slice(1)
  } else if (relative?.[0]) {
    prefix = relative[0]
    normalized = normalized.slice(prefix.length)
  }
  return {
    prefix,
    segments: normalized.split('/').filter(Boolean),
  }
}

function formatDirectoryPath(prefix: string, segments: string[]): string {
  if (segments.length === 0) return prefix || '/'
  return `${prefix}${segments.join('/')}/`
}

/**
 * Fit a directory path without cutting directory names in half.
 *
 * Interior segments are removed in an expanding centre-out sequence: centre,
 * left, right, left, right. The first and last directory are protected for as
 * long as that representation fits. It next keeps the last directory complete
 * (`.../last/`); if even that cannot fit, the path alone yields to `...`.
 */
export function collapseDirectoryPathToFit(
  directoryPath: string,
  maxWidth: number,
  measure: TextWidthMeasure,
): string {
  const { prefix, segments } = parseDirectoryPath(directoryPath)
  const full = formatDirectoryPath(prefix, segments)
  const available = Number.isFinite(maxWidth) ? Math.max(0, maxWidth) : 0
  const fits = (candidate: string): boolean => measure(candidate) <= available

  if (fits(full)) return full

  if (segments.length >= 3) {
    const removed = new Set<number>()
    const center = Math.floor((segments.length - 1) / 2)
    const removalOrder: number[] = [center]
    for (let distance = 1; removalOrder.length < segments.length - 2; distance++) {
      const left = center - distance
      const right = center + distance
      if (left > 0) removalOrder.push(left)
      if (right < segments.length - 1) removalOrder.push(right)
    }

    for (const index of removalOrder) {
      removed.add(index)
      const visible: string[] = []
      let ellipsisAdded = false
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        if (removed.has(segmentIndex)) {
          if (!ellipsisAdded) {
            visible.push('...')
            ellipsisAdded = true
          }
        } else {
          visible.push(segments[segmentIndex]!)
        }
      }
      const candidate = formatDirectoryPath(prefix, visible)
      if (fits(candidate)) return candidate
    }
  }

  if (segments.length >= 2) {
    const last = segments.at(-1)!
    const rootedLastOnly = formatDirectoryPath(prefix, ['...', last])
    if (fits(rootedLastOnly)) return rootedLastOnly
    const lastOnly = formatDirectoryPath('', ['...', last])
    if (fits(lastOnly)) return lastOnly
  }
  return '...'
}
