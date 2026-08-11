export function isQuickMenuOpen(menu: HTMLDivElement | null): boolean {
  return menu?.style.display === 'flex' && menu.classList.contains('tpl-sn-menu-visible')
}

/** Keep the editor selection on pointer-down; native click handles mouse and keyboard once. */
export function bindQuickAction(button: HTMLButtonElement, run: () => void): void {
  button.addEventListener('mousedown', event => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    run()
  })
}
