# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-08-11
- Primary product surfaces: Typora editor integrations, Quick Open, Plugin Center, plugin settings, sidenotes, code and note utilities.
- Evidence reviewed: `README.md`, `packages/core/src/ui/*`, `plugins/*/src/main.ts`, responsive and Quick Open tests, live Typora DOM geometry, and `/Users/cdcd/roobli/lr00rl/Typora_Claude-Like_Theme/claude-like.css` plus its contract tests.

## Brand
- Personality: Quiet, editorial, dependable, and native to the current Typora theme.
- Trust signals: Successful actions reflect confirmed host state; failures remain visible and actionable; plugin UI never silently drops records or sub-operations.
- Avoid: Generic dashboard or command-palette skins, hard-coded GitHub blue, decorative gradients, emoji as interface icons, fixed desktop minimum widths, and plugin/theme cascade fights.

## Product goals
- Goals: Extend Typora without destabilizing editing; keep file navigation fast and trustworthy; make every overlay keyboard-first; preserve readable document geometry at every window and sidebar size.
- Non-goals: Replace Typora's entire UI, introduce a standalone design system, or make companion themes responsible for plugin behavior.
- Success signals: No page-level horizontal scrolling from plugin geometry; every successful file open appears in Recent exactly once per observed transition; search ranking is backend-consistent; critical flows work by mouse and keyboard; light and dark themes remain legible.

## Personas and jobs
- Primary personas: Keyboard-heavy writers, researchers with large note trees, technical authors using wide tables/code, and theme users who expect a coherent reading environment.
- User jobs: Open a known or recently used file quickly; navigate a workspace without losing context; widen dense documents when space permits; add and read margin notes without breaking editing.
- Key contexts of use: Small laptop windows, a visible/resizable Typora sidebar, full-screen desktop writing, light/dark themes, CJK input, and large workspaces.

## Information architecture
- Primary navigation: Typora remains primary; Plugin Center is secondary configuration; Quick Open is the global file-navigation surface.
- Core routes/screens: Editor, Quick Open dialog, Plugin Center master/detail dialog, contextual sidenote action menu.
- Content hierarchy: Current task/input first, results or settings second, diagnostics and shortcut hints last.

## Design principles
- Host geometry is authoritative: Size against the visible editor host, never the outer window or a device label.
- Modes preserve intent and degrade safely: `default`, `wide`, and `full` remain selected preferences but converge when the available host cannot distinguish them.
- Confirm before recording success: History, notices, and state changes follow confirmed host outcomes.
- One owner per behavior: Plugins own injected runtime geometry and interaction; themes provide semantic tokens and static-document fallback styling.
- Keyboard is a first-class path: Every pointer action has an equivalent semantic, focused keyboard action.
- Tradeoffs: Prefer a slightly narrower, stable editor over retaining a requested width that introduces horizontal scrolling; prefer consistent in-process reranking over raw external-tool ordering.

## Visual language
- Color: Consume host/theme semantic variables first (`--bg-color`, `--text-color`, `--border-color`, `--accent-color`, selection/success/danger equivalents); keep neutral fallbacks.
- Typography: Inherit the active Typora/theme UI family; use the theme monospace family only for paths, shortcuts, and diagnostic values.
- Spacing/layout rhythm: Compact 4/8px rhythm for transient tools; 12/16/24px hierarchy for dialogs and settings. Quick Open is one command surface rather than stacked header, tab, results, and footer cards: the input and search modes share one strip, results stay dense, and diagnostics remain quiet.
- Shape/radius/elevation: Moderate 6-12px radii and one restrained dialog elevation; no ornamental gradients.
- Motion: 120-180ms opacity/transform or geometry feedback only; all nonessential motion disabled under `prefers-reduced-motion`.
- Imagery/iconography: Small authored vector/CSS icons and familiar platform glyphs; no platform emoji in operational chrome; decorative glyphs are hidden from assistive technology.
- Quick Open signature: Preserve the first version's lightweight, single-task character. Search is the sole visual anchor; filenames use regular-weight softened ink rather than bold black, while paths read as quieter monospace marginalia. In a one-line result the complete filename is the highest-priority information and always takes its uncapped natural width; a fixed gap separates it from the path, which owns only the remaining width. Fit long paths by removing complete directory segments from the centre outward while preserving the first and last directories; when even the complete last directory cannot fit, reduce the path alone to `...` rather than compressing the filename. Results use compact 34px desktop rows, and selection is communicated by a neutral translucent row surface alone—never a left accent rail, loud color block, or heavier type. Let the dialog follow its result count naturally and cap dense result sets at 75% of the dynamic viewport height; do not impose a tall empty shell on short lists.

## Components
- Existing components to reuse: Core `Plugin`, `PluginSettings`, event bus, settings renderer, theme variables, notices, and editor API.
- New/changed components: Shared editor-host width measurement; reliable active-file recorder; an accessible editorial Quick Open command surface; responsive Plugin Center.
- Variants and states: Default/wide modal and editor modes; loaded/disabled/busy/error plugins; recent/indexing/searching/empty/error Quick Open states; inline/margin sidenotes.
- Token/component ownership: Core owns plugin chrome tokens; each plugin owns its DOM and behavior; the companion theme may override semantic tokens but not `.tpl-*` runtime geometry.

## Accessibility
- Target standard: WCAG 2.2 AA where the Typora host surface permits it.
- Keyboard/focus behavior: Dialogs expose dialog semantics, trap focus, close on Escape, and restore the trigger; list navigation retains arrow-key speed; native buttons implement pointer actions.
- Contrast/readability: Selected, hover, active, focus, and error states remain distinguishable in light and dark themes; focus is never removed without a visible replacement.
- Screen-reader semantics: Inputs have names; tabs, lists, options, switches, and statuses expose state; async search/save changes use polite live regions.
- Reduced motion and sensory considerations: Respect `prefers-reduced-motion`; never rely on color alone for status.

## Responsive behavior
- Supported breakpoints/devices: Any Typora window at or above 320px; breakpoints are derived from the visible editor host when behavior depends on document space.
- Layout adaptations: `#write` must satisfy `rendered width <= visible editor host width - shell gutters`; wide/full collapse without changing the stored preference; sidenotes become inline unless prose plus one sidenote gutter fit; dialogs use viewport-safe inline and block sizes; Plugin Center becomes a usable single-column flow on narrow windows.
- Touch/hover differences: Pointer targets remain usable without hover; hover is enhancement only; transient surfaces contain overscroll.

## Interaction states
- Loading: Preserve input and navigation while showing a concise live status.
- Empty: Explain whether there is no history, no match, no index, or no configuration, with the next useful action when one exists.
- Error: State the failed operation and recovery step; do not render a success state for partial or failed work.
- Success: Announce only after persistence or host action is confirmed.
- Disabled: Preserve configuration and clearly distinguish disabled from not yet loaded.
- Offline/slow network, if applicable: Local plugins do not depend on network; slow filesystem/index operations remain cancellable by closing the surface and cannot overwrite newer render results.

## Content voice
- Tone: Direct, calm, and operational.
- Terminology: Use one language consistently within a surface; use "Recent", "Files", "Folders", "Content", "Wide", and "Full" consistently with commands and notices.
- Microcopy rules: Use active verbs, `…` for in-progress states, and specific failure recovery; shortcut hints supplement rather than replace labels.

## Implementation constraints
- Framework/styling system: TypeScript and framework-free DOM/CSS inside Typora WKWebView/Electron.
- Design-token constraints: Prefer host/theme variables with core fallbacks; no new design-system dependency.
- Performance constraints: No whole-document observer on typing hot paths; index/search work is debounced and stale results are discarded; ResizeObserver callbacks perform bounded layout work.
- Compatibility constraints: macOS WKWebView and Windows/Linux Electron; sidebars may resize without a window resize; theme styles may load before or after plugin styles.
- Test/screenshot expectations: Pure layout/recording/scoring tests first, DOM semantics tests for overlays/settings, full typecheck/build, companion-theme contract tests, and live Typora geometry smoke checks for sidebar-open responsive behavior.

## Open questions
- [ ] Identify an official Typora host event for every successful manual file open. The current compatibility adapter observes callback/Promise confirmation, rebinds when the private host method changes, and retains active-path polling only as a non-fatal fallback. Owner: core runtime. Impact: a host build that exposes neither a wrappable open method nor stable active paths cannot provide exact transition history.
- [ ] Decide whether the companion theme should keep legacy non-plugin `.sidenote`/`.marginnote` layout as an explicit standalone feature. Owner: theme. Impact: determines which selectors can be removed safely.
- [ ] Define localization policy for plugin chrome; current surfaces mix Chinese and English. Owner: product. Impact: copy consistency, not behavioral correctness.
