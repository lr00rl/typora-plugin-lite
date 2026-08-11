/**
 * Plugin Settings Renderer — turns a SettingsSchema<T> into DOM.
 *
 * Contract:
 *   - `renderSettings(ctx)` returns the root HTMLElement the caller appends
 *     into the detail pane of the Plugin Center.
 *   - The element stays live: every input is wired to ctx.settings, edits are
 *     validated → debounced (400ms) → persisted. Save status is visualized
 *     per field (spinner → green check).
 *   - `destroyRender(root)` clears any pending timers + detaches listeners.
 *     Plugin Center calls this when the user selects a different plugin.
 *
 * CSS class prefix: `tpl-pc-`. Colours from theme vars exported by theme.ts.
 *
 * No framework; pure DOM. Every kind has an explicit builder that shares a
 * `makeField()` skeleton for label/description/status/error.
 */

import type { PluginSettings } from '../plugin/settings.js'
import type {
  FieldDescriptor,
  SecretField,
  SettingsSchema,
} from '../plugin/settings-schema.js'
import { groupBySection } from '../plugin/settings-schema.js'

const CLS = 'tpl-pc-'
const SAVE_DEBOUNCE_MS = 400
const SAVE_CONFIRM_MS = 1500
const SECRET_REVEAL_MS = 15_000
const COPY_FEEDBACK_MS = 1200

export interface RenderContext<T extends Record<string, unknown>> {
  /** Live settings instance (loaded) or a detached one backed by defaults. */
  settings: PluginSettings<T>
  schema: SettingsSchema<T>
  /** Stable manifest id used for control ids; falls back to pluginName for direct callers. */
  pluginId?: string
  pluginName: string
  pluginVersion: string
  pluginDescription?: string
  /** If false, renders a "Plugin is disabled — changes apply on next enable" banner. */
  isLoaded: boolean
  /** Persistent user intent; an enabled lazy plugin may still be runtime-idle. */
  isEnabled?: boolean
  /** Hook fired after every successful save (debounced). Optional. */
  onFieldSaved?: (key: string, value: unknown) => void
}

// ---- Cleanup registry ---------------------------------------------------
// Renderers attach disposables keyed to the root element; destroyRender()
// walks them. WeakMap prevents leaks if the caller forgets to destroy.

const cleanups = new WeakMap<HTMLElement, Array<() => void>>()
const flushers = new WeakMap<HTMLElement, Array<() => Promise<void>>>()
function registerCleanup(root: HTMLElement, fn: () => void): void {
  let list = cleanups.get(root)
  if (!list) { list = []; cleanups.set(root, list) }
  list.push(fn)
}

function registerFlusher(root: HTMLElement, fn: () => Promise<void>): void {
  let list = flushers.get(root)
  if (!list) { list = []; flushers.set(root, list) }
  list.push(fn)
}

export async function flushRender(root: HTMLElement): Promise<void> {
  const list = flushers.get(root) ?? []
  await Promise.all(list.map(flush => flush()))
}

export function destroyRender(root: HTMLElement): void {
  void flushRender(root).catch(err => {
    console.error('[tpl:settings] failed to flush pending settings while closing the form:', err)
  })
  const list = cleanups.get(root)
  if (!list) return
  for (const fn of list) {
    try { fn() } catch { /* swallow, teardown must not throw */ }
  }
  cleanups.delete(root)
  flushers.delete(root)
}

// ---- Save orchestration -------------------------------------------------

interface FieldStatusApi {
  setSaving(): void
  setSaved(): void
  setError(message: string | null): void
  setIdle(): void
}

function safeIdPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'setting'
}

/**
 * Build a debounced saver that runs validate → set → save and updates the
 * per-field status indicator.
 */
function makeSaver<T extends Record<string, unknown>>(
  root: HTMLElement,
  ctx: RenderContext<T>,
  key: keyof T,
  field: FieldDescriptor,
  status: FieldStatusApi,
): (raw: T[keyof T]) => void {
  let debounceTimer: number | null = null
  let savedTimer: number | null = null
  let revision = 0
  let destroyed = false
  let pending: { raw: T[keyof T]; revision: number } | null = null
  const inFlight = new Set<Promise<void>>()

  const persist = async (entry: { raw: T[keyof T]; revision: number }): Promise<void> => {
    try {
      ctx.settings.set(key, entry.raw)
      await ctx.settings.save()
      ctx.onFieldSaved?.(String(key), entry.raw)
      if (destroyed || entry.revision !== revision) return
      status.setSaved()
      savedTimer = window.setTimeout(() => {
        if (!destroyed && entry.revision === revision) status.setIdle()
        savedTimer = null
      }, SAVE_CONFIRM_MS)
    } catch (err) {
      if (!destroyed && entry.revision === revision) {
        status.setError(err instanceof Error ? err.message : 'Save failed')
      }
      throw err
    }
  }

  const startPersist = (entry: { raw: T[keyof T]; revision: number }): Promise<void> => {
    const run = persist(entry)
    inFlight.add(run)
    void run.then(
      () => { inFlight.delete(run) },
      () => { inFlight.delete(run) },
    )
    return run
  }

  const flushPending = async (): Promise<void> => {
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer)
      debounceTimer = null
    }
    const entry = pending
    pending = null
    if (entry) startPersist(entry)
    await Promise.all([...inFlight])
  }

  registerFlusher(root, flushPending)

  registerCleanup(root, () => {
    destroyed = true
    if (savedTimer !== null) { window.clearTimeout(savedTimer); savedTimer = null }
  })

  return (raw: T[keyof T]) => {
    revision += 1
    const err = runValidator(field, raw)
    if (err != null) {
      pending = null
      if (debounceTimer !== null) { window.clearTimeout(debounceTimer); debounceTimer = null }
      status.setError(err)
      return
    }
    status.setError(null)
    status.setSaving()
    if (debounceTimer !== null) window.clearTimeout(debounceTimer)
    if (savedTimer !== null) { window.clearTimeout(savedTimer); savedTimer = null }
    pending = { raw, revision }
    debounceTimer = window.setTimeout(() => {
      void flushPending().catch(err => {
        console.error(`[tpl:settings] failed to save "${String(key)}":`, err)
      })
    }, SAVE_DEBOUNCE_MS)
  }
}

function runValidator(field: FieldDescriptor, raw: unknown): string | null {
  switch (field.kind) {
    case 'string':
      return typeof field.validate === 'function' ? field.validate(String(raw)) : null
    case 'number':
      return typeof field.validate === 'function' ? field.validate(Number(raw)) : null
    default:
      return null
  }
}

// ---- Shared field skeleton ----------------------------------------------

function makeField(
  field: FieldDescriptor,
  control: HTMLElement,
  pluginName: string,
  key: string,
): { wrapper: HTMLElement; status: FieldStatusApi } {
  const baseId = `tpl-setting-${safeIdPart(pluginName)}-${safeIdPart(key)}`
  const wrapper = document.createElement('div')
  wrapper.className = `${CLS}field${field.advanced ? ` ${CLS}field-advanced` : ''}`

  const header = document.createElement('div')
  header.className = `${CLS}field-header`
  const label = document.createElement('label')
  label.className = `${CLS}field-label`
  label.id = `${baseId}-label`
  label.textContent = field.label
  const statusSlot = document.createElement('span')
  statusSlot.className = `${CLS}field-status`
  statusSlot.id = `${baseId}-status`
  statusSlot.setAttribute('role', 'status')
  statusSlot.setAttribute('aria-live', 'polite')
  header.appendChild(label)
  header.appendChild(statusSlot)
  wrapper.appendChild(header)

  if (field.description) {
    const desc = document.createElement('div')
    desc.className = `${CLS}field-desc`
    desc.id = `${baseId}-description`
    desc.textContent = field.description
    wrapper.appendChild(desc)
  }

  const controlRow = document.createElement('div')
  controlRow.className = `${CLS}field-control`
  controlRow.appendChild(control)
  wrapper.appendChild(controlRow)

  const errorEl = document.createElement('div')
  errorEl.className = `${CLS}field-error`
  errorEl.id = `${baseId}-error`
  errorEl.setAttribute('aria-live', 'assertive')
  wrapper.appendChild(errorEl)

  const primary = control.matches('[data-setting-control]')
    ? control
    : control.querySelector<HTMLElement>('[data-setting-control]')
  if (primary) {
    primary.id = baseId
    primary.setAttribute('name', key)
    primary.setAttribute('aria-labelledby', label.id)
    const describedBy = [
      field.description ? `${baseId}-description` : null,
      statusSlot.id,
      errorEl.id,
    ].filter(Boolean).join(' ')
    primary.setAttribute('aria-describedby', describedBy)
    primary.setAttribute('aria-errormessage', errorEl.id)
    if (primary.matches('input, select, button')) label.htmlFor = primary.id
  }

  const status: FieldStatusApi = {
    setSaving() { statusSlot.textContent = 'Saving…'; statusSlot.className = `${CLS}field-status ${CLS}saving` },
    setSaved()  { statusSlot.textContent = 'Saved'; statusSlot.className = `${CLS}field-status ${CLS}saved` },
    setIdle()   { statusSlot.textContent = ''; statusSlot.className = `${CLS}field-status` },
    setError(msg) {
      errorEl.textContent = msg ?? ''
      errorEl.style.display = msg ? 'block' : 'none'
      if (primary) primary.setAttribute('aria-invalid', String(!!msg))
      if (msg) statusSlot.className = `${CLS}field-status ${CLS}error`
      else if (!statusSlot.textContent) statusSlot.className = `${CLS}field-status`
    },
  }
  status.setError(null)

  return { wrapper, status }
}

function wrapControl(input: HTMLElement, prefix: string | null): HTMLElement {
  if (!prefix) return input
  const wrap = document.createElement('div')
  wrap.className = `${CLS}input-wrap`
  const pfx = document.createElement('span')
  pfx.className = `${CLS}input-prefix`
  pfx.textContent = prefix
  wrap.appendChild(pfx)
  wrap.appendChild(input)
  return wrap
}

// ---- Per-kind control builders -----------------------------------------

function buildToggle<T extends Record<string, unknown>>(
  root: HTMLElement, ctx: RenderContext<T>, key: keyof T, field: Extract<FieldDescriptor, { kind: 'toggle' }>,
): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.setAttribute('role', 'switch')
  btn.dataset.settingControl = ''
  btn.className = `${CLS}toggle${field.dangerous ? ` ${CLS}toggle-dangerous` : ''}`
  const knob = document.createElement('span')
  knob.className = `${CLS}toggle-knob`
  btn.appendChild(knob)

  const { wrapper, status } = makeField(field, btn, ctx.pluginId ?? ctx.pluginName, String(key))
  const save = makeSaver(root, ctx, key, field, status)

  const v0 = !!ctx.settings.get(key)
  btn.setAttribute('aria-checked', String(v0))
  btn.classList.toggle(`${CLS}toggle-on`, v0)

  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true'
    if (field.dangerous && next) {
      const ok = window.confirm(
        `Enable "${field.label}"?\n\n` +
        (field.description ?? 'This setting is marked dangerous.'),
      )
      if (!ok) return
    }
    btn.setAttribute('aria-checked', String(next))
    btn.classList.toggle(`${CLS}toggle-on`, next)
    save(next as T[keyof T])
  })

  return wrapper
}

function buildString<T extends Record<string, unknown>>(
  root: HTMLElement, ctx: RenderContext<T>, key: keyof T, field: Extract<FieldDescriptor, { kind: 'string' | 'path' }>,
): HTMLElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.dataset.settingControl = ''
  const mono = field.kind === 'path' || (field.kind === 'string' && field.monospace)
  input.className = `${CLS}input${mono ? ` ${CLS}input-mono` : ''}`
  if (field.placeholder) input.placeholder = field.placeholder
  input.value = String(ctx.settings.get(key) ?? '')

  const prefix = field.kind === 'path' ? '\u{1F4C1}' : null // 📁
  const { wrapper, status } = makeField(field, wrapControl(input, prefix), ctx.pluginId ?? ctx.pluginName, String(key))
  const save = makeSaver(root, ctx, key, field, status)

  input.addEventListener('input', () => save(input.value as T[keyof T]))
  input.addEventListener('blur', () => save(input.value as T[keyof T]))

  return wrapper
}

function buildNumber<T extends Record<string, unknown>>(
  root: HTMLElement, ctx: RenderContext<T>, key: keyof T, field: Extract<FieldDescriptor, { kind: 'number' }>,
): HTMLElement {
  const input = document.createElement('input')
  input.type = 'number'
  input.dataset.settingControl = ''
  input.className = `${CLS}input`
  if (field.min != null) input.min = String(field.min)
  if (field.max != null) input.max = String(field.max)
  if (field.step != null) input.step = String(field.step)
  if (field.placeholder) input.placeholder = field.placeholder
  const initial = ctx.settings.get(key)
  input.value = initial != null ? String(initial) : ''

  const { wrapper, status } = makeField(field, input, ctx.pluginId ?? ctx.pluginName, String(key))
  const save = makeSaver(root, ctx, key, field, status)

  const commit = () => {
    if (input.value === '') { status.setError('Required'); return }
    const n = Number(input.value)
    if (Number.isNaN(n)) { status.setError('Not a number'); return }
    save(n as T[keyof T])
  }
  input.addEventListener('input', commit)
  input.addEventListener('blur', commit)

  return wrapper
}

function buildEnum<T extends Record<string, unknown>>(
  root: HTMLElement, ctx: RenderContext<T>, key: keyof T, field: Extract<FieldDescriptor, { kind: 'enum' }>,
): HTMLElement {
  const useSegmented =
    field.style === 'segmented' ||
    (field.style !== 'select' && field.options.length <= 3)

  if (useSegmented) {
    const control = document.createElement('div')
    control.className = `${CLS}segmented`
    control.dataset.settingControl = ''
    control.setAttribute('role', 'group')
    const btns = field.options.map(opt => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `${CLS}segmented-opt`
      b.name = String(key)
      b.dataset.value = opt.value
      b.textContent = opt.label
      if (opt.hint) b.title = opt.hint
      control.appendChild(b)
      return b
    })
    const apply = (v: string) => {
      for (const b of btns) {
        const active = b.dataset.value === v
        b.setAttribute('aria-pressed', String(active))
        b.classList.toggle(`${CLS}segmented-opt-active`, active)
      }
    }
    const { wrapper, status } = makeField(field, control, ctx.pluginId ?? ctx.pluginName, String(key))
    const save = makeSaver(root, ctx, key, field, status)
    apply(String(ctx.settings.get(key) ?? ''))
    for (const b of btns) {
      b.addEventListener('click', () => {
        const v = b.dataset.value!
        apply(v)
        save(v as T[keyof T])
      })
    }
    return wrapper
  }

  const select = document.createElement('select')
  select.className = `${CLS}select`
  select.dataset.settingControl = ''
  for (const opt of field.options) {
    const o = document.createElement('option')
    o.value = opt.value
    o.textContent = opt.label
    if (opt.hint) o.title = opt.hint
    select.appendChild(o)
  }
  select.value = String(ctx.settings.get(key) ?? '')

  const { wrapper, status } = makeField(field, select, ctx.pluginId ?? ctx.pluginName, String(key))
  const save = makeSaver(root, ctx, key, field, status)
  select.addEventListener('change', () => save(select.value as T[keyof T]))
  return wrapper
}

function buildSecret<T extends Record<string, unknown>>(
  root: HTMLElement, ctx: RenderContext<T>, key: keyof T, field: SecretField,
): HTMLElement {
  const revealable = field.revealable !== false
  const copyable = field.copyable !== false

  const input = document.createElement('input')
  input.type = 'password'
  input.dataset.settingControl = ''
  input.readOnly = true
  input.className = `${CLS}input ${CLS}input-mono`
  // NEVER write the raw value to the DOM before Reveal.
  input.value = ''
  input.placeholder = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

  const actions = document.createElement('div')
  actions.className = `${CLS}secret-actions`

  let revealTimer: number | null = null
  let revealBtn: HTMLButtonElement | null = null

  const remask = () => {
    input.type = 'password'
    input.value = ''
    if (revealTimer !== null) { window.clearTimeout(revealTimer); revealTimer = null }
    if (revealBtn) revealBtn.textContent = 'Reveal'
  }
  registerCleanup(root, remask)

  if (revealable) {
    revealBtn = document.createElement('button')
    revealBtn.type = 'button'
    revealBtn.className = `${CLS}btn ${CLS}btn-quiet`
    revealBtn.textContent = 'Reveal'
    revealBtn.addEventListener('click', () => {
      if (input.type === 'text') { remask(); return }
      input.type = 'text'
      input.value = String(ctx.settings.get(key) ?? '')
      revealBtn!.textContent = 'Hide'
      revealTimer = window.setTimeout(remask, SECRET_REVEAL_MS)
    })
    actions.appendChild(revealBtn)
  }

  if (copyable) {
    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = `${CLS}btn ${CLS}btn-quiet`
    copyBtn.textContent = 'Copy'
    copyBtn.addEventListener('click', async () => {
      const raw = String(ctx.settings.get(key) ?? '')
      if (!raw) return
      try {
        await navigator.clipboard.writeText(raw)
        copyBtn.textContent = 'Copied!'
        copyBtn.classList.add(`${CLS}btn-success`)
        window.setTimeout(() => {
          copyBtn.textContent = 'Copy'
          copyBtn.classList.remove(`${CLS}btn-success`)
        }, COPY_FEEDBACK_MS)
      } catch {
        copyBtn.textContent = 'Copy failed'
        window.setTimeout(() => { copyBtn.textContent = 'Copy' }, COPY_FEEDBACK_MS)
      }
    })
    actions.appendChild(copyBtn)
  }

  const wrap = document.createElement('div')
  wrap.className = `${CLS}secret-wrap`
  wrap.appendChild(input)
  wrap.appendChild(actions)

  const { wrapper, status } = makeField(field, wrap, ctx.pluginId ?? ctx.pluginName, String(key))
  const save = makeSaver(root, ctx, key, field, status)

  if (field.regenerate) {
    const regenBtn = document.createElement('button')
    regenBtn.type = 'button'
    regenBtn.className = `${CLS}btn ${CLS}btn-quiet`
    regenBtn.textContent = 'Regenerate'
    regenBtn.addEventListener('click', () => {
      const ok = window.confirm(
        `Regenerate ${field.label}? Existing clients will lose access until they pick up the new value.`,
      )
      if (!ok) return
      const next = field.regenerate!()
      save(next as T[keyof T])
      remask()
    })
    actions.appendChild(regenBtn)
  }

  return wrapper
}

// ---- Top-level orchestration -------------------------------------------

export function renderSettings<T extends Record<string, unknown>>(
  ctx: RenderContext<T>,
): HTMLElement {
  const root = document.createElement('div')
  root.className = `${CLS}detail`

  // Header
  const header = document.createElement('div')
  header.className = `${CLS}detail-header`

  const titleRow = document.createElement('div')
  titleRow.className = `${CLS}detail-title`
  const nameSpan = document.createElement('span')
  nameSpan.className = `${CLS}detail-name`
  nameSpan.textContent = ctx.pluginName
  const versionSpan = document.createElement('span')
  versionSpan.className = `${CLS}detail-version`
  versionSpan.textContent = `v${ctx.pluginVersion}`
  titleRow.appendChild(nameSpan)
  titleRow.appendChild(versionSpan)
  header.appendChild(titleRow)

  if (ctx.pluginDescription) {
    const descDiv = document.createElement('div')
    descDiv.className = `${CLS}detail-desc`
    descDiv.textContent = ctx.pluginDescription
    header.appendChild(descDiv)
  }
  root.appendChild(header)

  if (ctx.isEnabled === false) {
    const banner = document.createElement('div')
    banner.className = `${CLS}banner`
    banner.textContent = 'Plugin is disabled — changes will apply on next enable.'
    root.appendChild(banner)
  } else if (!ctx.isLoaded) {
    const banner = document.createElement('div')
    banner.className = `${CLS}banner`
    banner.textContent = 'Plugin is enabled and will load when its trigger runs.'
    root.appendChild(banner)
  }

  // Empty-schema placeholder
  const fieldCount = Object.keys(ctx.schema.fields).length
  if (fieldCount === 0) {
    const empty = document.createElement('div')
    empty.className = `${CLS}empty-schema`
    empty.textContent = 'This plugin has no configurable settings.'
    root.appendChild(empty)
    return root
  }

  // Sections
  const sectionsContainer = document.createElement('div')
  sectionsContainer.className = `${CLS}sections`
  root.appendChild(sectionsContainer)

  const resolved = groupBySection(ctx.schema)
  const showSectionHeadings = resolved.length > 1 || (resolved[0]?.title ?? 'General') !== 'General'

  for (const section of resolved) {
    const sectionEl = document.createElement('div')
    sectionEl.className = `${CLS}section`
    if (showSectionHeadings) {
      const heading = document.createElement('div')
      heading.className = `${CLS}section-title`
      heading.textContent = section.title
      sectionEl.appendChild(heading)
    }

    const fieldsEl = document.createElement('div')
    fieldsEl.className = `${CLS}fields`
    sectionEl.appendChild(fieldsEl)

    const all = ctx.settings.getAll() as Record<string, unknown>
    for (const [key, field] of section.fields) {
      if (field.hidden && field.hidden(all)) continue
      let el: HTMLElement
      switch (field.kind) {
        case 'toggle': el = buildToggle(root, ctx, key, field); break
        case 'string':
        case 'path':   el = buildString(root, ctx, key, field); break
        case 'number': el = buildNumber(root, ctx, key, field); break
        case 'enum':   el = buildEnum(root, ctx, key, field); break
        case 'secret': el = buildSecret(root, ctx, key, field); break
        default: {
          const _exhaustive: never = field
          void _exhaustive
          continue
        }
      }
      fieldsEl.appendChild(el)
    }
    sectionsContainer.appendChild(sectionEl)
  }

  return root
}
