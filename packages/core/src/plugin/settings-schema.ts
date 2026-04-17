/**
 * Declarative settings schema for plugins.
 *
 * Each plugin that wants a UI in the Plugin Center declares a static
 * `settingsSchema` on its class. The schema maps setting keys (subset of the
 * plugin's settings shape `T`) to `FieldDescriptor`s which the settings
 * renderer translates into concrete DOM primitives.
 *
 * A field descriptor is a discriminated union on `kind` — TypeScript narrows
 * per-case when switched on, so renderer code gets exhaustive + type-safe
 * access to per-kind extras (options, validators, etc).
 *
 * Two special keys on the schema object tune layout without polluting the
 * value-key space:
 *   - `__sections` groups fields under labeled, optionally collapsible headings.
 *   - `__order` pins field order; keys absent from the list follow naturally.
 *
 * Plugins with NO schema show a friendly placeholder in the UI; no changes
 * required to existing plugins that don't opt in.
 */

export interface SectionSpec {
  title: string
  /** Lower numbers render first. Unspecified sections render after numbered ones, alphabetically. */
  order?: number
  /** If true, section body is collapsed by default behind a disclosure triangle. */
  collapsible?: boolean
}

interface BaseField {
  /** Short human label shown above the control. */
  label: string
  /** Optional longer description shown below the label (muted). */
  description?: string
  /**
   * Section key — arbitrary string. Fields sharing a section render together
   * under a heading declared in `__sections`. Missing → implicit "General".
   */
  section?: string
  /** Collapse this field behind an "Advanced" disclosure within its section. */
  advanced?: boolean
  /** Predicate reading the full settings snapshot; returning true hides the field. */
  hidden?: (all: Record<string, unknown>) => boolean
}

export interface ToggleField extends BaseField {
  kind: 'toggle'
  /** Flip to visually mark the toggle as dangerous and prompt for confirmation on enable. */
  dangerous?: boolean
}

export interface StringField extends BaseField {
  kind: 'string'
  placeholder?: string
  /** Render with monospace font (e.g. for paths, tokens, URLs). */
  monospace?: boolean
  /** Return null for ok, or an error message to block save and render inline. */
  validate?: (value: string) => string | null
}

export interface NumberField extends BaseField {
  kind: 'number'
  min?: number
  max?: number
  step?: number
  placeholder?: string
  validate?: (value: number) => string | null
}

export interface EnumOption {
  value: string
  label: string
  /** Optional short explanation shown next to the option. */
  hint?: string
}

export interface EnumField extends BaseField {
  kind: 'enum'
  options: EnumOption[]
  /**
   * 'segmented' for a 3-button inline control, 'select' for a dropdown,
   * 'auto' picks segmented when options.length <= 3 (default).
   */
  style?: 'segmented' | 'select' | 'auto'
}

export interface SecretField extends BaseField {
  kind: 'secret'
  /** Allow the user to click "Reveal" to briefly see the value (auto-re-masks after 15s). Default true. */
  revealable?: boolean
  /** Show a "Copy" button that writes the raw value to the clipboard. Default true. */
  copyable?: boolean
  /**
   * Optional action to regenerate the value in-place. Return the new secret;
   * the renderer persists via settings.set() + settings.save().
   */
  regenerate?: () => string
}

export interface PathField extends BaseField {
  kind: 'path'
  placeholder?: string
  /** Render with monospace + folder glyph. Does NOT perform filesystem validation by itself. */
  mustExist?: boolean
}

export type FieldDescriptor =
  | ToggleField
  | StringField
  | NumberField
  | EnumField
  | SecretField
  | PathField

/**
 * Schema object.
 *
 * Nested shape (fields / sections / order) intentionally chosen over a flat
 * map with reserved `__*` keys: the flat form collides with TypeScript's
 * index-signature rules, forcing `sections` to be assignable to `FieldDescriptor`.
 * Nesting also reads better for authors — one "real settings" block, one
 * "layout meta" block, no reserved key gotchas.
 */
export interface SettingsSchema<T extends Record<string, unknown>> {
  fields: { [K in keyof T]?: FieldDescriptor }
  /** Optional section metadata keyed by the `field.section` string. */
  sections?: Record<string, SectionSpec>
  /**
   * Pin field order; unlisted keys follow insertion order.
   * Constrained to string keys so subclass specializations stay variance-safe
   * with the base class declaration on Plugin.
   */
  order?: Array<Extract<keyof T, string>>
}

// ---- Helpers -------------------------------------------------------------

/**
 * Iterate fields in the caller's preferred order:
 *   1. Keys listed in `schema.order` (when also present in `schema.fields`).
 *   2. Remaining `schema.fields` keys in object insertion order.
 */
export function orderedFields<T extends Record<string, unknown>>(
  schema: SettingsSchema<T>,
): Array<[keyof T, FieldDescriptor]> {
  const entries: Array<[keyof T, FieldDescriptor]> = []
  const seen = new Set<string>()

  for (const key of schema.order ?? []) {
    const field = schema.fields[key]
    if (field) {
      entries.push([key, field])
      seen.add(key as string)
    }
  }
  for (const key of Object.keys(schema.fields) as Array<keyof T>) {
    if (seen.has(key as string)) continue
    const field = schema.fields[key]
    if (field) entries.push([key, field])
  }
  return entries
}

/**
 * Group ordered fields by section key. Missing section → "General".
 *
 * Sections render in priority:
 *   (a) declared sections with `order` numeric, ASC;
 *   (b) declared sections without `order`, alphabetical by title;
 *   (c) undeclared sections, alphabetical.
 */
export interface ResolvedSection<T extends Record<string, unknown>> {
  key: string
  title: string
  collapsible: boolean
  fields: Array<[keyof T, FieldDescriptor]>
}

export function groupBySection<T extends Record<string, unknown>>(
  schema: SettingsSchema<T>,
): ResolvedSection<T>[] {
  const buckets = new Map<string, Array<[keyof T, FieldDescriptor]>>()
  for (const [key, field] of orderedFields(schema)) {
    const section = field.section ?? 'General'
    const list = buckets.get(section) ?? []
    list.push([key, field])
    buckets.set(section, list)
  }

  const declared = schema.sections ?? {}
  const sections: ResolvedSection<T>[] = []
  for (const [key, fields] of buckets.entries()) {
    const spec = declared[key]
    sections.push({
      key,
      title: spec?.title ?? key,
      collapsible: spec?.collapsible ?? false,
      fields,
    })
  }
  sections.sort((a, b) => {
    const oa = declared[a.key]?.order
    const ob = declared[b.key]?.order
    if (oa != null && ob != null) return oa - ob
    if (oa != null) return -1
    if (ob != null) return 1
    return a.title.localeCompare(b.title)
  })
  return sections
}
