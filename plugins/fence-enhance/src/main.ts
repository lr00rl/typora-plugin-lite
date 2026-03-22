import { Plugin } from '@typora-plugin-lite/core'

const CSS = `
/* Line numbers via CSS counters */
.md-fences .CodeMirror-code {
  counter-reset: tpl-line;
}
.md-fences .CodeMirror-line::before {
  counter-increment: tpl-line;
  content: counter(tpl-line);
  display: inline-block;
  width: 2.5em;
  margin-right: 0.8em;
  text-align: right;
  color: var(--text-color, #999);
  opacity: 0.4;
  font-size: 0.85em;
  user-select: none;
  pointer-events: none;
}

/* Copy button */
.tpl-fence-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  padding: 2px 8px;
  border: 1px solid rgba(128,128,128,0.3);
  border-radius: 4px;
  background: rgba(128,128,128,0.1);
  color: var(--text-color, #666);
  font-size: 12px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 10;
}
.md-fences:hover .tpl-fence-copy {
  opacity: 1;
}
.tpl-fence-copy:hover {
  background: rgba(128,128,128,0.2);
}
.tpl-fence-copy.tpl-copied {
  color: #4caf50;
}

/* Ensure fences are positioned for absolute children */
.md-fences {
  position: relative;
}
`

export default class FenceEnhancePlugin extends Plugin {
  private observer: MutationObserver | null = null

  onload(): void {
    this.registerCss(CSS)

    // Process existing fences
    this.processAllFences()

    // Watch for new fences added to DOM
    const writeArea = document.querySelector('#write')
    if (writeArea) {
      this.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node instanceof HTMLElement) {
              if (node.classList?.contains('md-fences')) {
                this.addCopyButton(node)
              } else {
                node.querySelectorAll?.('.md-fences')?.forEach(el => {
                  this.addCopyButton(el as HTMLElement)
                })
              }
            }
          }
        }
      })
      this.observer.observe(writeArea, { childList: true, subtree: true })
      this.addDisposable(() => this.observer?.disconnect())
    }
  }

  private processAllFences(): void {
    document.querySelectorAll('.md-fences').forEach(el => {
      this.addCopyButton(el as HTMLElement)
    })
  }

  private addCopyButton(fence: HTMLElement): void {
    if (fence.querySelector('.tpl-fence-copy')) return

    const btn = document.createElement('button')
    btn.className = 'tpl-fence-copy'
    btn.textContent = 'Copy'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.copyFenceContent(fence, btn)
    })
    fence.appendChild(btn)
  }

  private copyFenceContent(fence: HTMLElement, btn: HTMLElement): void {
    // Get text from CodeMirror lines or fallback to textContent
    const lines = fence.querySelectorAll('.CodeMirror-line')
    let text: string

    if (lines.length > 0) {
      text = Array.from(lines)
        .map(line => {
          // Clone to avoid modifying DOM, strip line number pseudo-elements
          const clone = line.cloneNode(true) as HTMLElement
          return clone.textContent ?? ''
        })
        .join('\n')
    } else {
      // Fallback
      const codeEl = fence.querySelector('code') ?? fence.querySelector('pre')
      text = codeEl?.textContent ?? fence.textContent ?? ''
    }

    navigator.clipboard.writeText(text.trimEnd()).then(() => {
      btn.textContent = 'Copied!'
      btn.classList.add('tpl-copied')
      setTimeout(() => {
        btn.textContent = 'Copy'
        btn.classList.remove('tpl-copied')
      }, 1500)
    }).catch(() => {
      // Fallback for environments where clipboard API is unavailable
      btn.textContent = 'Failed'
      setTimeout(() => { btn.textContent = 'Copy' }, 1500)
    })
  }
}
