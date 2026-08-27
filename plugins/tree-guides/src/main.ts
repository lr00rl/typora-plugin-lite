import { Plugin } from '@typora-plugin-lite/core'
import { buildGuidePaths, type GuideGroup, type GuideMetrics } from './geometry'

const SVG_NS = 'http://www.w3.org/2000/svg'
const TREE_SELECTOR = '#file-library-tree'

/** Typora's rows are 30px and its children containers indent by 20px. */
const METRICS: GuideMetrics = { arm: 14, radius: 8 }

/**
 * The theme draws these lines with background gradients and SVG data URIs on
 * each row, because a theme is only CSS. With a plugin the whole guide can be
 * one stroke, so it is drawn here instead and the theme's version stands down.
 *
 * Nothing in Typora's tree is made `position: relative` on purpose: the theme
 * documents that doing so breaks Typora's focusToFile(), which walks the
 * offsetTop chain. The overlay is fixed to the tree's visible box and redrawn
 * on scroll, which also means only rows on screen are ever measured.
 */
const CSS = /* css */ `
#tpl-tree-guides {
  position: fixed;
  pointer-events: none;
  z-index: 1;
  /* Clipped to the tree's visible box: a group whose parent has scrolled away
     must not trail a stroke up over the sidebar header or the title bar. */
  overflow: hidden;
}
#tpl-tree-guides path {
  fill: none;
  stroke: var(--tree-line-color, rgba(0, 0, 0, 0.12));
  stroke-width: 1;
  stroke-linecap: round;
  shape-rendering: geometricPrecision;
}
#tpl-tree-guides path.tpl-guide-lit {
  stroke: var(--accent-color, #a85d3b);
  stroke-width: 1.4;
  opacity: 0.85;
}

/* The theme's own connectors: one stroke replaces all of them. */
html.tpl-tree-guides-on ${TREE_SELECTOR} .file-node-children {
  background-image: none !important;
}
html.tpl-tree-guides-on ${TREE_SELECTOR} .file-tree-node:not(.file-node-root) > .file-node-content::before,
html.tpl-tree-guides-on ${TREE_SELECTOR} .file-node-children > div:last-of-type > .file-node-content::before,
html.tpl-tree-guides-on ${TREE_SELECTOR} .file-node-children > div:last-of-type > .file-node-content::after {
  display: none !important;
}
`

export default class TreeGuidesPlugin extends Plugin {
  private svg: SVGSVGElement | null = null
  private basePath: SVGPathElement | null = null
  private litPath: SVGPathElement | null = null
  private observer: MutationObserver | null = null
  private scrollHost: HTMLElement | null = null
  private pending = 0

  onload(): void {
    this.registerCss(CSS)
    document.documentElement.classList.add('tpl-tree-guides-on')
    this.addDisposable(() => document.documentElement.classList.remove('tpl-tree-guides-on'))

    this.registerDomEvent(window, 'resize', () => this.schedule())
    // The sidebar can be mounted after the plugin loads, and the tree is
    // rebuilt wholesale whenever the vault or a folder changes.
    this.observer = new MutationObserver(() => this.schedule())
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    })
    this.addDisposable(() => this.observer?.disconnect())

    this.schedule()
  }

  onunload(): void {
    if (this.pending) window.clearTimeout(this.pending)
    this.pending = 0
    this.svg?.remove()
    this.svg = null
    this.basePath = null
    this.litPath = null
    this.detachScrollHost()
  }

  private schedule(): void {
    if (this.pending) return
    this.pending = window.setTimeout(() => {
      this.pending = 0
      try {
        this.draw()
      } catch (err) {
        console.error('[tpl] tree-guides draw failed:', err)
      }
    }, 0)
  }

  private detachScrollHost(): void {
    if (!this.scrollHost) return
    this.scrollHost.removeEventListener('scroll', this.onScroll)
    this.scrollHost = null
  }

  private onScroll = (): void => this.schedule()

  /** The tree scrolls inside itself or an ancestor; find it once and follow it. */
  private attachScrollHost(tree: HTMLElement): void {
    let node: HTMLElement | null = tree
    while (node && node !== document.body) {
      const overflow = getComputedStyle(node).overflowY
      if (overflow === 'auto' || overflow === 'scroll') break
      node = node.parentElement
    }
    const host = node && node !== document.body ? node : null
    if (host === this.scrollHost) return
    this.detachScrollHost()
    if (!host) return
    this.scrollHost = host
    host.addEventListener('scroll', this.onScroll, { passive: true })
  }

  private ensureSvg(): SVGSVGElement {
    if (this.svg && this.svg.isConnected) return this.svg
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
    svg.id = 'tpl-tree-guides'
    svg.setAttribute('aria-hidden', 'true')
    this.basePath = document.createElementNS(SVG_NS, 'path') as SVGPathElement
    this.litPath = document.createElementNS(SVG_NS, 'path') as SVGPathElement
    this.litPath.setAttribute('class', 'tpl-guide-lit')
    svg.appendChild(this.basePath)
    svg.appendChild(this.litPath)
    document.body.appendChild(svg)
    this.svg = svg
    return svg
  }

  private draw(): void {
    const tree = document.querySelector<HTMLElement>(TREE_SELECTOR)
    if (!tree || !tree.getClientRects().length) {
      if (this.svg) this.svg.style.display = 'none'
      return
    }
    this.attachScrollHost(tree)

    const svg = this.ensureSvg()
    const box = (this.scrollHost ?? tree).getBoundingClientRect()
    svg.style.display = ''
    svg.style.left = `${box.left}px`
    svg.style.top = `${box.top}px`
    svg.style.width = `${box.width}px`
    svg.style.height = `${box.height}px`

    const active = tree.querySelector('.file-tree-node.active')
    const groups: GuideGroup[] = []

    const containers = tree.querySelectorAll<HTMLElement>('.file-node-children')
    for (const container of containers) {
      const rect = container.getBoundingClientRect()
      if (rect.height < 4) continue
      // Nothing on screen: skip the measuring entirely. A container on the
      // open file's branch stays in: its rows may be pinned in view long
      // after the container itself has scrolled past.
      const onActiveBranch = !!active && container.contains(active)
      if (!onActiveBranch && (rect.bottom < box.top - 40 || rect.top > box.bottom + 40)) continue

      // The theme pins the ancestors of the open file to the top of the
      // sidebar. A pinned folder row leaves its container behind, so the
      // group starts at the row's current bottom, not at the container's.
      const parentRow = container.parentElement?.querySelector<HTMLElement>(
        ':scope > .file-node-content',
      )
      const parentBottom =
        parentRow && parentRow.getClientRects().length
          ? parentRow.getBoundingClientRect().bottom
          : box.top
      const top = Math.max(rect.top, parentBottom, box.top)

      const children = Array.from(container.children) as HTMLElement[]
      const arms: number[] = []
      let activeIndex = -1
      for (let i = 0; i < children.length; i += 1) {
        const row = children[i]!.querySelector<HTMLElement>(':scope > .file-node-content')
        if (!row) continue
        const rowRect = row.getBoundingClientRect()
        arms.push(Math.round(rowRect.top - box.top + rowRect.height / 2) + 0.5)
        if (active && children[i]!.contains(active)) activeIndex = arms.length - 1
      }
      if (!arms.length) continue

      groups.push({
        x: Math.round(rect.left - box.left) + 0.5,
        top: Math.round(top - box.top) + 0.5,
        arms,
        activeIndex,
      })
    }

    const paths = buildGuidePaths(groups, METRICS)
    this.basePath?.setAttribute('d', paths.base)
    this.litPath?.setAttribute('d', paths.lit)
  }
}
