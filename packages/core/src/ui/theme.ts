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
      --tpl-bg: rgba(30, 30, 30, 0.95);
      --tpl-text: #ddd;
      --tpl-text-muted: #888;
      --tpl-border: rgba(255, 255, 255, 0.1);
      --tpl-accent: #6cb6ff;
      --tpl-toggle-on: #58a6ff;
      --tpl-toggle-off: #555;
      --tpl-hover: rgba(255, 255, 255, 0.05);
      --tpl-active: rgba(108, 182, 255, 0.12);
      --tpl-panel-split: rgba(255, 255, 255, 0.08);
      --tpl-field-bg: rgba(255, 255, 255, 0.04);
      --tpl-field-border: rgba(255, 255, 255, 0.12);
      --tpl-field-focus: #6cb6ff;
      --tpl-danger: #ff6369;
      --tpl-success: #4cc38a;
      --tpl-muted-bg: rgba(255, 255, 255, 0.06);
      --tpl-mono: 'SF Mono', 'Menlo', 'Consolas', monospace;
    `
  }
  return `
    --tpl-bg: rgba(255, 255, 255, 0.95);
    --tpl-text: #333;
    --tpl-text-muted: #888;
    --tpl-border: rgba(0, 0, 0, 0.1);
    --tpl-accent: #0969da;
    --tpl-toggle-on: #0969da;
    --tpl-toggle-off: #ccc;
    --tpl-hover: rgba(0, 0, 0, 0.03);
    --tpl-active: rgba(9, 105, 218, 0.08);
    --tpl-panel-split: rgba(0, 0, 0, 0.08);
    --tpl-field-bg: rgba(0, 0, 0, 0.03);
    --tpl-field-border: rgba(0, 0, 0, 0.12);
    --tpl-field-focus: #0969da;
    --tpl-danger: #e5484d;
    --tpl-success: #30a46c;
    --tpl-muted-bg: rgba(0, 0, 0, 0.04);
    --tpl-mono: 'SF Mono', 'Menlo', 'Consolas', monospace;
  `
}
