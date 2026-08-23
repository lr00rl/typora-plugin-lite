/**
 * All note-assistant styling in one pass. Palette + inline block share the
 * same `--tpl-na-*` token layer, which falls back through the system-wide
 * `--tpl-ui-*` vars to Typora theme vars, with a color-mix upgrade where
 * supported. No gradients, no blur, no hard-coded colors — the surface is
 * meant to read as native to whichever theme is active.
 */

export const CSS = `
#tpl-na-overlay {
  --tpl-na-ink-soft: var(--tpl-ui-text, var(--text-color, #34312e));
  --tpl-na-ink-selected: var(--tpl-ui-text, var(--text-color, #34312e));
  --tpl-na-muted: var(--tpl-ui-muted, var(--text-color, #6f6b66));
  --tpl-na-faint: var(--tpl-ui-muted, var(--text-color, #8c8781));
  --tpl-na-hairline: var(--tpl-ui-border, var(--border-color, rgba(128,128,128,0.14)));
  --tpl-na-accent-soft: var(--tpl-ui-accent, var(--accent-color, #a85d3b));
  --tpl-na-selection-soft: var(--tpl-ui-selection, rgba(168, 93, 59, 0.08));
  --tpl-na-hover-soft: var(--tpl-ui-surface-subtle, rgba(128,128,128,0.035));
  --tpl-na-row-selected: var(--tpl-ui-surface-subtle, rgba(128,128,128,0.07));
  position: fixed;
  inset: 0;
  background: rgba(22, 20, 18, 0.20);
  z-index: 99998;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  box-sizing: border-box;
  padding: clamp(32px, 9vh, 80px) 16px 16px;
  overflow: hidden;
}
@supports (color: color-mix(in srgb, black, transparent)) {
  #tpl-na-overlay {
    --tpl-na-ink-soft: color-mix(in srgb, var(--tpl-ui-text, var(--text-color, #34312e)) 82%, transparent);
    --tpl-na-ink-selected: color-mix(in srgb, var(--tpl-ui-text, var(--text-color, #34312e)) 92%, transparent);
    --tpl-na-muted: color-mix(in srgb, var(--tpl-ui-text, var(--text-color, #34312e)) 54%, transparent);
    --tpl-na-faint: color-mix(in srgb, var(--tpl-ui-text, var(--text-color, #34312e)) 40%, transparent);
    --tpl-na-hairline: color-mix(in srgb, var(--tpl-ui-text, var(--text-color, #34312e)) 10%, transparent);
    --tpl-na-accent-soft: color-mix(in srgb, var(--tpl-ui-accent, var(--accent-color, #a85d3b)) 72%, transparent);
    --tpl-na-selection-soft: color-mix(in srgb, var(--tpl-ui-accent, var(--accent-color, #a85d3b)) 8%, transparent);
    --tpl-na-hover-soft: color-mix(in srgb, var(--tpl-ui-text, var(--text-color, #34312e)) 3.5%, transparent);
    --tpl-na-row-selected: color-mix(in srgb, var(--tpl-ui-text, var(--text-color, #34312e)) 7%, transparent);
  }
}
#tpl-na-modal {
  color: var(--tpl-na-ink-soft);
  background: var(--tpl-ui-surface, var(--bg-color, #fff));
  font-family: var(--tpl-ui-font, inherit);
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  border-radius: max(10px, var(--tpl-ui-radius, 10px));
  box-shadow:
    0 0 0 1px rgba(24, 22, 20, 0.05),
    0 2px 6px rgba(24, 22, 20, 0.05),
    0 24px 64px rgba(24, 22, 20, 0.13);
  overflow: hidden;
  border: 1px solid var(--tpl-na-hairline);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-width: 0;
  max-height: min(75vh, calc(100vh - 48px));
  max-height: min(75dvh, calc(100dvh - 48px));
  width: min(740px, calc(100vw - 32px));
}
#tpl-na-input-row {
  display: flex;
  align-items: center;
  min-height: 52px;
  padding: 0 16px;
  gap: 10px;
  border-bottom: 1px solid var(--tpl-na-hairline);
  flex-shrink: 0;
  transition: box-shadow 120ms ease-out;
}
#tpl-na-input-row:focus-within {
  box-shadow: inset 0 -2px 0 var(--tpl-na-accent-soft);
}
#tpl-na-input {
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
  flex: 1;
  min-width: 0;
  min-height: 52px;
  padding: 0;
  margin: 0;
  font-size: 16px;
  font-weight: 400;
  line-height: 1.35;
  letter-spacing: -0.01em;
  background: transparent;
  color: var(--tpl-na-ink-selected);
  caret-color: var(--tpl-na-accent-soft);
  font-family: var(--tpl-ui-font, inherit);
}
#tpl-na-input::placeholder {
  color: var(--tpl-na-faint);
  opacity: 1;
}
#tpl-na-tab-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-inline-start: 6px;
  padding-inline-start: 10px;
  border-inline-start: 1px solid var(--tpl-na-hairline);
  flex-shrink: 0;
}
.tpl-na-tab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--tpl-na-muted);
  font-family: inherit;
  min-height: 32px;
  padding: 5px 9px 4px;
  font-size: 11.5px;
  line-height: 1;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  user-select: none;
  transition: color 120ms ease-out, border-color 120ms ease-out;
}
.tpl-na-tab:hover {
  color: var(--tpl-na-ink-soft);
}
.tpl-na-tab-active {
  color: var(--tpl-na-accent-soft);
  border-bottom-color: var(--tpl-na-accent-soft);
}
#tpl-na-list {
  flex: 0 1 auto;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  min-height: 0;
  padding: 4px 6px 6px;
}
.tpl-na-item {
  min-height: 34px;
  padding: 4px 12px 4px 10px;
  cursor: pointer;
  display: grid;
  grid-template-columns: max-content max-content minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  border-radius: 4px;
  box-shadow: none;
}
.tpl-na-item.tpl-na-selected {
  background: var(--tpl-na-row-selected);
}
@media (hover: hover) and (pointer: fine) {
  .tpl-na-item:not(.tpl-na-selected):hover {
    background: var(--tpl-na-hover-soft);
  }
}
.tpl-na-name {
  font-size: 13.5px;
  font-weight: 400;
  line-height: 1.25;
  color: var(--tpl-na-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 340px;
}
.tpl-na-hit {
  color: var(--tpl-na-accent-soft);
  background: transparent;
  border-radius: 0;
  box-shadow: inset 0 -0.34em 0 var(--tpl-na-selection-soft);
}
.tpl-na-badge {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--tpl-na-selection-soft);
  color: var(--tpl-na-muted);
  user-select: none;
}
.tpl-na-path {
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.25;
  color: var(--tpl-na-muted);
  font-family: var(--tpl-ui-mono, var(--monospace, 'SF Mono', Menlo, Consolas, monospace));
  text-align: end;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tpl-na-status {
  padding: 24px 14px;
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
  color: var(--tpl-na-muted);
}
.tpl-na-overflow-note {
  padding: 5px 10px 3px;
  font-size: 11px;
  line-height: 1.3;
  color: var(--tpl-na-muted);
  user-select: none;
}
#tpl-na-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 30px;
  padding: 5px 16px;
  font-size: 11px;
  color: var(--tpl-na-muted);
  font-variant-numeric: tabular-nums;
  border-top: 1px solid var(--tpl-na-hairline);
  white-space: nowrap;
  overflow: hidden;
  flex-shrink: 0;
  user-select: none;
}
#tpl-na-footer-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
#tpl-na-footer-hints {
  flex-shrink: 0;
  color: var(--tpl-na-faint);
}
#tpl-na-footer-action {
  border: 0;
  border-bottom: 1px solid currentColor;
  background: transparent;
  color: var(--tpl-na-accent-soft);
  border-radius: 0;
  padding: 1px 0;
  margin-inline-start: 10px;
  font-size: 11px;
  line-height: 1.35;
  cursor: pointer;
  flex-shrink: 0;
}
#tpl-na-footer-action:hover {
  color: var(--tpl-ui-accent-hover, var(--accent-hover-color, currentColor));
}
#tpl-na-footer-action[hidden] {
  display: none;
}
#tpl-na-footer-action:disabled {
  cursor: default;
  opacity: 0.45;
}
.tpl-na-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
#tpl-na-modal :is(button, [role="option"]):focus-visible {
  outline: 2px solid var(--tpl-na-accent-soft) !important;
  outline-offset: 2px;
}
#tpl-na-input:focus-visible {
  outline: none !important;
}
@media (max-width: 620px) {
  #tpl-na-input-row {
    flex-wrap: wrap;
    padding: 0 12px 6px;
    column-gap: 9px;
  }
  #tpl-na-input { flex: 1 1 100%; min-height: 46px; }
  #tpl-na-tab-bar {
    order: 2;
    flex: 1 0 100%;
    margin-inline-start: 0;
    padding: 4px 0 0;
    border-inline-start: 0;
    border-top: 1px solid var(--tpl-na-hairline);
  }
  .tpl-na-item { grid-template-columns: max-content minmax(0, 1fr); }
  .tpl-na-badge { display: none; }
  .tpl-na-path { text-align: end; }
  #tpl-na-footer-hints { display: none; }
}
@media (max-width: 520px) {
  #tpl-na-overlay { padding-inline: 8px; padding-top: 8px; }
  #tpl-na-modal { width: calc(100vw - 16px); }
  #tpl-na-footer { padding-inline: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  #tpl-na-input-row,
  .tpl-na-tab {
    transition: none;
  }
}

/* ---- inline block: quiet, lives inside #write ---- */

#write.tpl-has-note-assistant-block .tpl-note-assistant-comment {
  display: none;
}
#write.tpl-has-note-assistant-block .tpl-note-assistant-source-hidden {
  display: none !important;
}
#write .tpl-note-assistant-inline {
  margin: 14px 0 18px;
  padding: 2px 0 0;
}
#write .tpl-note-assistant-inline-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  user-select: none;
}
#write .tpl-note-assistant-inline-title {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--tpl-ui-muted, var(--text-color, inherit));
  opacity: 0.72;
}
#write .tpl-note-assistant-inline-count {
  font-size: 11px;
  color: var(--tpl-ui-muted, var(--text-color, inherit));
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
#write .tpl-note-assistant-inline-open {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--tpl-ui-muted, var(--text-color, inherit));
  opacity: 0.45;
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
  padding: 0 2px;
  cursor: pointer;
}
#write .tpl-note-assistant-inline-open:hover {
  opacity: 1;
  color: var(--tpl-ui-accent, var(--accent-color, inherit));
}
#write .tpl-note-assistant-inline-list {
  display: grid;
  gap: 1px;
  margin-top: 4px;
}
#write .tpl-note-assistant-inline-item {
  appearance: none;
  border: 0;
  background: transparent;
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 3px 8px;
  margin-inline-start: -8px;
  border-radius: 4px;
  text-align: start;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  #write .tpl-note-assistant-inline-item:hover {
    background: var(--tpl-ui-surface-subtle, rgba(128,128,128,0.05));
  }
}
#write .tpl-note-assistant-inline-item:focus-visible {
  outline: 2px solid var(--tpl-ui-accent, var(--accent-color, currentColor));
  outline-offset: 1px;
}
#write .tpl-note-assistant-inline-item-title {
  font-size: 13px;
  line-height: 1.45;
  color: var(--tpl-ui-text, var(--text-color, inherit));
  opacity: 0.86;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
  min-width: 0;
}
#write .tpl-note-assistant-inline-item-path {
  font-size: 11px;
  line-height: 1.45;
  color: var(--tpl-ui-muted, var(--text-color, inherit));
  opacity: 0.5;
  font-family: var(--tpl-ui-mono, var(--monospace, 'SF Mono', Menlo, Consolas, monospace));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex-shrink: 2;
}
`
