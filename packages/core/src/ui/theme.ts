/**
 * Theme detection for Typora — provides dark/light mode awareness
 * and CSS custom properties for tpl UI components.
 */

/** Detect if Typora is in dark mode by checking body classes. */
export function isDarkMode(): boolean {
  const cl = document.body.classList
  return cl.contains('os-dark') || cl.contains('dark-mode') || cl.contains('night')
}

/** CSS custom properties block, toggled by dark mode. */
export function themeVars(): string {
  if (isDarkMode()) {
    return `
      --tpl-bg: var(--tpl-ui-surface, var(--bg-color, rgba(30, 30, 30, 0.95)));
      --tpl-text: var(--tpl-ui-text, var(--text-color, #ddd));
      --tpl-text-muted: var(--tpl-ui-muted, #999);
      --tpl-border: var(--tpl-ui-border, var(--border-color, rgba(255, 255, 255, 0.14)));
      --tpl-accent: var(--tpl-ui-accent, var(--accent-color, var(--link-color, #6cb6ff)));
      --tpl-toggle-on: var(--tpl-ui-accent, #58a6ff);
      --tpl-toggle-off: #555;
      --tpl-hover: var(--tpl-ui-surface-subtle, rgba(255, 255, 255, 0.07));
      --tpl-active: var(--tpl-ui-selection, rgba(108, 182, 255, 0.16));
      --tpl-panel-split: var(--tpl-ui-border, rgba(255, 255, 255, 0.08));
      --tpl-field-bg: var(--tpl-ui-surface-subtle, rgba(255, 255, 255, 0.04));
      --tpl-field-border: var(--tpl-ui-border, rgba(255, 255, 255, 0.12));
      --tpl-field-focus: var(--tpl-ui-accent, #6cb6ff);
      --tpl-danger: var(--tpl-ui-danger, #ff6369);
      --tpl-success: var(--tpl-ui-success, #4cc38a);
      --tpl-muted-bg: var(--tpl-ui-surface-subtle, rgba(255, 255, 255, 0.06));
      --tpl-mono: var(--tpl-ui-mono, 'SF Mono', 'Menlo', 'Consolas', monospace);
    `
  }
  return `
    --tpl-bg: var(--tpl-ui-surface, var(--bg-color, rgba(255, 255, 255, 0.95)));
    --tpl-text: var(--tpl-ui-text, var(--text-color, #333));
    --tpl-text-muted: var(--tpl-ui-muted, #747474);
    --tpl-border: var(--tpl-ui-border, var(--border-color, rgba(0, 0, 0, 0.14)));
    --tpl-accent: var(--tpl-ui-accent, var(--accent-color, var(--link-color, #0969da)));
    --tpl-toggle-on: var(--tpl-ui-accent, #0969da);
    --tpl-toggle-off: #ccc;
    --tpl-hover: var(--tpl-ui-surface-subtle, rgba(0, 0, 0, 0.05));
    --tpl-active: var(--tpl-ui-selection, rgba(9, 105, 218, 0.12));
    --tpl-panel-split: var(--tpl-ui-border, rgba(0, 0, 0, 0.08));
    --tpl-field-bg: var(--tpl-ui-surface-subtle, rgba(0, 0, 0, 0.03));
    --tpl-field-border: var(--tpl-ui-border, rgba(0, 0, 0, 0.12));
    --tpl-field-focus: var(--tpl-ui-accent, #0969da);
    --tpl-danger: var(--tpl-ui-danger, #e5484d);
    --tpl-success: var(--tpl-ui-success, #237a4b);
    --tpl-muted-bg: var(--tpl-ui-surface-subtle, rgba(0, 0, 0, 0.04));
    --tpl-mono: var(--tpl-ui-mono, 'SF Mono', 'Menlo', 'Consolas', monospace);
  `
}
