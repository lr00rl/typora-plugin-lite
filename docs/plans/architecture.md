# typora-plugin-lite: Cross-Platform Typora Plugin System

## Context

Migrating from Windows/Linux to macOS — [obgnail/typora_plugin](https://github.com/obgnail/typora_plugin) does not work on macOS. The root cause: macOS Typora is a native Swift/WKWebView app (not Electron), so `reqnode`, `require`, `process`, `global` are all undefined. Two projects (typora-community-plugin, typora-copilot) have solved cross-platform compatibility via IIFE bundling + `bridge.callHandler` abstraction.

**Goal**: Build an independent, minimal-invasiveness plugin system ("typora-plugin-lite", abbreviated **tpl**) that:
- Works on macOS first, with Win/Linux compatibility
- Provides 9 specific features the user needs
- Uses a micro-kernel + lazy-loading architecture inspired by lazy.nvim
- Stores all plugin data externally in `~/Library/Application Support/abnerworks.Typora/plugins/`
- Keeps Markdown files standard-compatible (uses YAML frontmatter + HTML comments for metadata)

---

## Architecture: Micro-kernel + Lazy Plugin Loading

### Layer Diagram

```
Typora App (WKWebView on macOS / Electron on Win+Linux)
  └── loader.js (~30 lines, IIFE, injected via <script> tag)
        └── import(core.js) — ESM dynamic import
              ├── Platform Abstraction (fs / shell / path)
              ├── PluginManager (scan / lazy-load / unload)
              ├── UI Runtime (spotlight panel / toast / status-bar)
              ├── Editor API (getMarkdown / setMarkdown / fence processors)
              ├── tpl Marker Parser (HTML comment + frontmatter)
              └── Hotkey Manager (Mod cross-platform mapping)
                    │
                    ▼
              plugins/ (each is an independent ESM module)
              ├── md-padding        [startup]
              ├── fence-enhance     [startup]
              ├── title-shift       [command]
              ├── todo-manager      [startup]
              ├── drawio            [event: fenceblock:render]
              ├── timeline          [event: fenceblock:render]
              ├── fuzzy-search      [hotkey: Mod+Shift+F]
              ├── recent-files      [startup]
              └── file-tags         [hotkey: Mod+Shift+T]
```

### Lazy Loading Strategy (lazy.nvim-inspired)

Each plugin's `manifest.json` declares its loading trigger:

```jsonc
{
  "id": "fuzzy-search",
  "name": "Fuzzy Search",
  "version": "0.1.0",
  "main": "main.js",
  "loading": {
    "startup": false,
    "event": [],
    "command": ["search"],
    "hotkey": ["Mod+Shift+F"]
  }
}
```

| Strategy | Trigger | Used by |
|----------|---------|---------|
| `startup: true` | Immediate on Typora load | md-padding, fence-enhance, todo-manager, recent-files |
| `event: [...]` | First matching event | drawio, timeline |
| `command: [...]` | Command palette invocation | title-shift |
| `hotkey: [...]` | First keypress | fuzzy-search, file-tags |

Lazy plugins get a **placeholder listener** registered at boot. On first trigger: `import(plugin/main.js)` → instantiate → `onload()` → replay the triggering event.

---

## Cross-Platform Abstraction Layer

### Runtime Detection

```ts
export const IS_MAC = typeof window !== 'undefined' && !!(window as any).bridge
export const IS_NODE = !IS_MAC
```

### Three Interfaces

**IFileSystem**:
- macOS: `bridge.callSync('path.readText')` for reads, `Shell.run()` for write/stat/mkdir/list/remove
- Win/Linux: `reqnode('fs').promises.*`

**IShell**:
- macOS: `bridge.callHandler("controller.runCommand", { args, cwd })` → Promise
- Win/Linux: `reqnode('child_process').exec`

**IPath**:
- macOS: Pure JS reimplementation (~60 lines)
- Win/Linux: `reqnode('path')`

All exposed via `platform.fs`, `platform.shell`, `platform.path`. Plugins never touch `bridge` or `reqnode` directly.

---

## Plugin Lifecycle

### Plugin Base Class

```ts
abstract class Plugin<T = {}> {
  onload(): void | Promise<void>
  onunload(): void  // auto-disposes all registered resources

  registerCommand(cmd: Command): void
  registerHotkey(key: string, callback: () => void): void
  registerEvent(event: string, handler: Function): void
  registerDomEvent(el: Element, event: string, handler: Function): void
  registerInterval(id: number): void
  registerCss(css: string): void
  registerFenceProcessor(lang: string, renderer: FenceRenderer): void
  registerMarkdownProcessor(processor: MarkdownProcessor): void
  addStatusBarItem(text: string): StatusBarItem
  showNotice(msg: string, duration?: number): void
}
```

All `register*` methods push to internal `disposables[]`. `unload()` auto-cleans everything.

### Inter-plugin Communication

Simple event bus: `this.app.events.emit('tags:updated', data)` / `this.registerEvent('tags:updated', handler)`

---

## Custom Marker Syntax (tpl markers)

### Design Principle
Standard Markdown first. All markers use existing Markdown mechanisms (YAML frontmatter + HTML comments). Zero conflict with any renderer.

### File-level Metadata → YAML Frontmatter

```yaml
---
title: My Note
tags: [claude, self-host]
tpl:
  version: 1
---
```

### Block-level Custom Content → HTML Comments + Standard Fenced Code Blocks

```markdown
<!-- tpl:block drawio -->
` ` `drawio
<mxGraphModel>...</mxGraphModel>
` ` `
<!-- /tpl:block -->
```

### Inline Commands → HTML Comments

```markdown
<!-- tpl:todo-checked 2026-03-21T14:30:00 -->
- [x] Complete design doc
```

### Typora Editor Visibility

Typora renders HTML comments as visible gray `<span class="md-comment">`. The plugin hides tpl markers via:
1. MutationObserver detects `.md-comment` spans matching `<!-- tpl:...`
2. Adds `.tpl-marker` class → `display: none` via CSS
3. Without plugin: markers show as gray text (not garbled, informative)

### Code Block Exclusion

Parser checks DOM ancestry (`.md-fences`, `<code>`, `<pre>`) before treating a comment as a tpl marker. Markdown-level parsing skips lines inside fenced blocks.

### Source of Truth

All tpl markers live in the `.md` file itself. Plugins read/modify via `editor.getMarkdown()` / `editor.setMarkdown()`. `.typora/data/` stores only non-document data (settings, caches, indices).

---

## UI Component System

### Spotlight Panel (shared by search, commands, tags, recent files)

- Injected as `<div id="tpl-ui-root">` at `document.body` end, `position: fixed`
- CSS isolation via `#tpl-ui-root { all: initial; }` — fully decoupled from Typora styles
- Theme: CSS variables `--tpl-bg`, `--tpl-text`, etc. with `.tpl-dark` variant, detected from Typora's body class
- Keyboard: ArrowUp/Down, Tab/Shift+Tab, Enter to confirm, Escape to close
- Reusable API: `spotlight.open({ placeholder, items, onSelect, onQuery, preview, groups })`

| Scenario | Trigger | Backend |
|----------|---------|---------|
| File search | `Mod+Shift+F` | rg via shell.run |
| Command palette | `Mod+Shift+P` | Registered commands list |
| Tag search | `Mod+Shift+T` | Tag index from .typora/data/ |
| Recent files | `Mod+E` | recent-files.json |

---

## Project Structure

```
typora-plugin-lite/
├── packages/
│   ├── core/src/              ← Micro-kernel
│   │   ├── platform/          ← fs, shell, path (mac + node)
│   │   ├── plugin/            ← Plugin base, PluginManager, settings
│   │   ├── ui/                ← spotlight, toast, status-bar, theme
│   │   ├── editor/            ← markdown API, fence processors, events
│   │   ├── parser/            ← tpl marker parser
│   │   └── hotkey/            ← hotkey manager
│   ├── loader/src/            ← Injected entry (~30 lines)
│   └── installer/             ← install.sh / uninstall.sh
├── plugins/                   ← Each plugin is independent
│   ├── md-padding/            ← S complexity
│   ├── fence-enhance/         ← S
│   ├── title-shift/           ← S
│   ├── todo-manager/          ← M
│   ├── drawio/                ← L
│   ├── timeline/              ← M
│   ├── fuzzy-search/          ← L
│   ├── recent-files/          ← S
│   └── file-tags/             ← L
├── docs/
│   ├── plans/                 ← Design documents
│   ├── plugin-dev-guide.md
│   └── marker-spec.md
├── scripts/build.ts
├── package.json               ← pnpm workspace root
├── tsconfig.json
└── esbuild.config.ts
```

### Build Pipeline

- **esbuild** for all builds (fast, <100ms incremental)
- `loader.js` → IIFE format (~1KB)
- `core.js` → ESM format (for `import()`)
- Each plugin → ESM format, `@typora-plugin-lite/core` as external
- CSS inlined into JS via `loader: { '.css': 'text' }`
- Dev mode: `esbuild --watch` + auto-copy to userdata dir, `Cmd+Shift+R` to reload Typora

### Installed File Layout

```
~/Library/Application Support/abnerworks.Typora/plugins/
├── loader.js           ← Only file referenced by Typora HTML
├── core.js
├── settings.json
├── data/               ← Plugin persistent data
└── plugins/
    ├── md-padding/     ← main.js + manifest.json
    ├── drawio/
    └── ...
```

---

## Installer

### macOS Install (one-time)

1. Detect Typora at `/Applications/Typora.app`
2. Find HTML entry (try `TypeMark/index.html`, `window.html`, `app/window.html`)
3. Copy `dist/*` to `~/Library/Application Support/abnerworks.Typora/plugins/`
4. Inject `<script src="file://.../plugins/loader.js" type="module"></script>` before `</body>` (idempotent: skip if already present)
5. Re-sign: `codesign -f -s - /Applications/Typora.app && xattr -cr /Applications/Typora.app`

### After Typora Update

`./install.sh repair` — re-injects script tag + re-signs. Plugin files in userdata are untouched.

### Uninstall

Remove script tag from HTML, re-sign. Plugin data preserved by default.

---

## 9 Features: Implementation Plan

### Phase 1 — Foundation + Simple Plugins

**Step 1: Project scaffolding** — pnpm workspace, tsconfig, esbuild config

**Step 2: Core platform layer** — detect, fs (darwin + node), shell, path

**Step 3: Plugin system** — Plugin base class, PluginManager with lazy loading, PluginSettings

**Step 4: Editor API + Hotkey manager** — markdown API, fence processors, events, cross-platform hotkey

**Step 5: Loader + Installer** — loader.js IIFE, install.sh/uninstall.sh

**Step 6: Three S-complexity plugins** — md-padding, fence-enhance, title-shift

### Phase 2 — UI + Medium Plugins

**Step 7: UI runtime** — spotlight panel, toast, status-bar, theme

**Step 8: tpl marker parser** — regex parsing with fence-block exclusion, MutationObserver

**Step 9: Fence processor registration** — hook into Typora's CodeMirror fence rendering

**Step 10: Three M/L-complexity plugins** — todo-manager, drawio, timeline

### Phase 3 — Shell Integration + Heavy Plugins

**Step 11: Shell integration hardening** — Timeout handling, error recovery

**Step 12: Three S/L-complexity plugins** — fuzzy-search, recent-files, file-tags
