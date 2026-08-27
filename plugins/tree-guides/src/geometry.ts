/**
 * Guide geometry for the file tree.
 *
 * A folder's guide is one path: the trunk drops from the top of the group to
 * the last row, turns into that row with a real radius, and every other row
 * hangs off it as an arm. Building it as a single stroke is what a CSS-only
 * theme cannot do, and it is why the corner can be a proper quarter turn
 * instead of a box border pretending to be one.
 */

export interface GuideGroup {
  /** Trunk position, relative to the overlay origin. */
  x: number
  /** Where the group starts, i.e. just under its folder row. */
  top: number
  /** Vertical centre of each child row, in order. */
  arms: number[]
  /** Index of the child on the open file's branch, or -1. */
  activeIndex: number
}

export interface GuideMetrics {
  /** How far an arm reaches toward its row. */
  arm: number
  /** Corner radius where the trunk turns into the last row. */
  radius: number
}

export interface GuidePaths {
  base: string
  lit: string
}

function corner(x: number, top: number, y: number, radius: number, arm: number): string {
  const r = Math.min(radius, Math.max(0, y - top))
  return (
    `M${x},${top}` +
    `L${x},${y - r}` +
    `Q${x},${y} ${x + r},${y}` +
    `L${x + arm},${y}`
  )
}

function branch(x: number, y: number, arm: number): string {
  return `M${x},${y}L${x + arm},${y}`
}

export function buildGuidePaths(groups: GuideGroup[], metrics: GuideMetrics): GuidePaths {
  let base = ''
  let lit = ''

  for (const group of groups) {
    if (group.arms.length === 0) continue
    const last = group.arms[group.arms.length - 1]!
    base += corner(group.x, group.top, last, metrics.radius, metrics.arm)
    for (let i = 0; i < group.arms.length - 1; i += 1) {
      base += branch(group.x, group.arms[i]!, metrics.arm)
    }

    const active = group.activeIndex
    if (active < 0 || active >= group.arms.length) continue
    const y = group.arms[active]!
    lit +=
      active === group.arms.length - 1
        ? corner(group.x, group.top, y, metrics.radius, metrics.arm)
        : `M${group.x},${group.top}L${group.x},${y}` + branch(group.x, y, metrics.arm)
  }

  return { base, lit }
}
