/**
 * Prompt engine — the section-API implementation.
 *
 * The plugin no longer listens to `system-prompt/assemble`. Instead:
 *  - on `agent/created` it samples the official assembly once, before any
 *    override exists (the only moment the official text is still readable),
 *  - it detects a `complete` preset with an empty sentinel section,
 *  - it registers overrides and user-added sections through
 *    `agent.ctx.systemPrompt.section()`, scoped to that one agent.
 *
 * Every registration is fail-open: a section that cannot be registered is
 * logged and skipped, never thrown into the agent-creation path. A session
 * that was never switched on gets no registrations at all.
 */
import {
  estimateTokens,
  isReadOnlySection,
  sectionSource,
  sensitivityOf,
  sha16
} from './store.js'
import { diagnoseProbeError } from './diagnostics.js'

const MAX_CAPTURE_TEXT = 200_000
const SENTINEL_ORDER = 1_000_000_000
const ORDER_CACHE_LIMIT = 40

export const ANCHOR_START = '__start__'
export const ANCHOR_END = '__end__'

/**
 * Fast path for official section placement. Values are Central order names from
 * `@deepseek-ai/dsh-system-prompt`; the service resolves them to numbers.
 * Sections not listed here are resolved by registry introspection (or, when
 * that is unavailable, by in-memory calibration).
 */
const STATIC_ORDER_NAMES = {
  'harness:identity': 'HARNESS_IDENTITY',
  'deployment:persona-prefix': 'DEPLOYMENT_PERSONA_PREFIX',
  'plan:policy': 'PLAN_POLICY',
  'team:policy': 'TEAM_POLICY',
  'tools:ptc-only': 'PTC_ONLY',
  'context:file-reference': 'FILE_REFERENCE',
  'tool:bash': 'TOOL_BASH',
  'tool:pwsh': 'TOOL_PWSH',
  'tool:read': 'TOOL_READ',
  'tool:write': 'TOOL_WRITE',
  'tool:edit': 'TOOL_EDIT',
  'tool:apply_patch': 'TOOL_APPLY_PATCH',
  'tool:glob': 'TOOL_GLOB',
  'tool:grep': 'TOOL_GREP',
  'tool:jobs': 'TOOL_JOBS',
  'tool:pty': 'TOOL_PTY',
  'tool:pty-panel': 'TOOL_PTY_PANEL',
  'tool:web_search': 'TOOL_WEB_SEARCH',
  'tool:web_fetch': 'TOOL_WEB_FETCH',
  'tool:lsp': 'TOOL_LSP',
  'tool:session-query': 'TOOL_SESSION_QUERY',
  'tool:goal': 'TOOL_GOAL',
  'tool:schedule': 'TOOL_SCHEDULE',
  'tool:workflow': 'TOOL_WORKFLOW',
  'tool:ralph': 'TOOL_RALPH',
  'tool:subagent': 'TOOL_SUBAGENT',
  'tool:report': 'TOOL_REPORT',
  'tool:computer_use': 'TOOL_COMPUTER_USE',
  'mcp-resource-servers': 'MCP_SERVERS',
  'tools:sdk': 'TOOLS_SDK',
  'ui:deliverable-file-references': 'DELIVERABLE_FILE_REFERENCES',
  'structured-output': 'STRUCTURED_OUTPUT',
  'tool:structured_output': 'STRUCTURED_OUTPUT',
  'harness:source': 'HARNESS_SOURCE',
  'app:web-surface': 'WEB_SURFACE',
  'deployment:persona-suffix': 'DEPLOYMENT_PERSONA_SUFFIX'
}

function warn (logger, message) {
  try {
    logger?.warn?.(`prompt-lab: ${message}`)
  } catch {
    /* logging must never break prompt assembly */
  }
}

function anchorOf (extra) {
  const value = typeof extra?.anchor === 'string' ? extra.anchor : ''
  if (value === ANCHOR_START || value === ANCHOR_END) return value
  if (value !== '') return value
  return extra?.position === 'start' ? ANCHOR_START : ANCHOR_END
}

/** Map a name that is no longer present to the end, matching what `sync` does. */
function normalizeAnchor (anchor, officialNames) {
  if (anchor === ANCHOR_START) return ANCHOR_START
  if (anchor === ANCHOR_END) return ANCHOR_END
  return officialNames.has(anchor) ? anchor : ANCHOR_END
}

/** The agent-scoped prompt registry; it must stay scoped or registration would be global. */
function promptOf (agent) {
  const ctx = agent?.ctx
  if (ctx === undefined) return null
  try {
    const direct = ctx.systemPrompt
    if (direct !== undefined && typeof direct.assemble === 'function') return direct
  } catch {
    /* fall through to the optional-service lookup */
  }
  try {
    const optional = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (optional !== undefined && typeof optional.assemble === 'function') return optional
  } catch {
    /* no prompt registry in this profile */
  }
  return null
}

function toRows (sections) {
  const rows = []
  for (const section of sections ?? []) {
    if (!section || typeof section.name !== 'string') continue
    const text = typeof section.text === 'string' ? section.text : ''
    rows.push({
      name: section.name,
      text: text.length > MAX_CAPTURE_TEXT ? text.slice(0, MAX_CAPTURE_TEXT) : text,
      hash: sha16(text)
    })
  }
  return rows
}

function fingerprintOf (rows) {
  return sha16(rows.map((row) => `${row.name}:${row.hash}`).sort().join('\n'))
}

/** Read definition orders from the registry's own layer table (read-only). */
function introspectOrders (agent, prompt) {
  try {
    const layers = prompt?.layers
    if (layers === undefined || typeof layers.merge !== 'function') return null
    const merged = layers.merge(agent, (layer) => layer.sections)
    const orders = new Map()
    for (const [name, definition] of merged) {
      if (Number.isFinite(definition?.order)) orders.set(name, definition.order)
    }
    return orders.size > 0 ? orders : null
  } catch {
    return null
  }
}

function staticOrder (prompt, name) {
  const key = STATIC_ORDER_NAMES[name]
  if (key === undefined) return null
  try {
    const value = prompt.getSectionOrder(key)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

const CALIBRATION_ROUNDS = 48
const CALIBRATION_SPAN = 1e9
const CALIBRATION_EPSILON = 1e-6

/**
 * Fallback placement finder: register an empty probe, assemble, and binary
 * search the order value that puts the probe immediately before the target
 * section. All probes are empty text, all are disposed in the same round, and
 * nothing is persisted. Only used when the registry's order table is
 * unavailable (a future Harness that hides it).
 *
 * A section is only `verified` when the probe actually landed at its index
 * (`before === index`). Anything else is reported in `unverified` with a
 * reason: an unobserved midpoint is a guess, and guessing one let a wrong
 * order enter the cache and survive every later attach.
 */
async function calibrateOrders (agent, prompt, rows, missing) {
  const indexByName = new Map(rows.map((row, index) => [row.name, index]))
  const baselineNames = new Set(rows.map((row) => row.name))
  const pending = missing
    .filter((name) => indexByName.has(name))
    .map((name) => ({
      name,
      index: indexByName.get(name),
      lo: -CALIBRATION_SPAN,
      hi: CALIBRATION_SPAN,
      order: null,
      state: 'pending',
      reason: null
    }))

  let rounds = 0
  let abortReason = null

  while (rounds < CALIBRATION_ROUNDS && pending.some((entry) => entry.state === 'pending')) {
    const active = pending.filter((entry) => entry.state === 'pending')
    const probes = []
    for (const entry of active) {
      const guess = (entry.lo + entry.hi) / 2
      const probeName = `prompt-lab:probe:${rounds}:${probes.length}`
      try {
        const dispose = agent.ctx.systemPrompt.section({
          name: probeName,
          order: guess,
          text: '',
          interpolate: false
        })
        probes.push({ entry, probeName, guess, dispose })
      } catch {
        entry.state = 'unverified'
        entry.reason = 'probe-register-failed'
      }
    }
    if (probes.length === 0) {
      if (abortReason === null) abortReason = 'probe-register-failed'
      break
    }

    let assembly = null
    try {
      assembly = await prompt.assemble({ agent, scope: agent })
    } catch {
      abortReason = 'assembly-failed'
      for (const entry of active) {
        if (entry.state === 'pending') {
          entry.state = 'unverified'
          entry.reason = 'assembly-failed'
        }
      }
    } finally {
      for (const probe of probes) {
        try {
          probe.dispose()
        } catch {
          /* already gone */
        }
      }
    }

    if (abortReason !== null) break
    if (!Array.isArray(assembly?.sections)) {
      abortReason = 'assembly-failed'
      for (const entry of active) {
        if (entry.state === 'pending') {
          entry.state = 'unverified'
          entry.reason = 'assembly-failed'
        }
      }
      break
    }

    const names = assembly.sections.map((section) => section.name)
    for (const { entry, probeName, guess } of probes) {
      if (entry.state !== 'pending') continue
      const at = names.indexOf(probeName)
      if (at < 0) {
        entry.state = 'unverified'
        entry.reason = 'probe-missing'
        continue
      }
      const before = names.slice(0, at).filter((name) => baselineNames.has(name)).length
      if (before < entry.index) entry.lo = guess
      else if (before > entry.index) entry.hi = guess
      else {
        entry.order = guess
        entry.state = 'verified'
        continue
      }
      if (entry.hi - entry.lo < CALIBRATION_EPSILON) {
        entry.state = 'unverified'
        entry.reason = 'no-separating-order'
      }
    }
    rounds += 1
  }

  const verified = new Map()
  const unverified = new Map()
  for (const entry of pending) {
    if (entry.state === 'verified') {
      verified.set(entry.name, entry.order)
    } else {
      unverified.set(entry.name, {
        reason: entry.reason ?? (abortReason === 'assembly-failed' ? 'assembly-failed' : 'rounds-exhausted')
      })
    }
  }

  let status = 'ok'
  if (verified.size < pending.length) {
    if (verified.size > 0) {
      status = 'partial'
    } else {
      const fatal = abortReason === 'assembly-failed' ||
        [...unverified.values()].some((entry) => entry.reason === 'probe-register-failed')
      status = fatal ? 'failed' : 'timeout'
    }
  }
  return { status, verified, unverified, rounds, reason: abortReason }
}

/** Log one calibration outcome without ever claiming success for a guess. */
function reportCalibration (logger, result, requested) {
  if (result.status === 'ok') {
    warn(logger, `calibrated prompt order for ${requested} section(s)`)
    return
  }
  const reasons = [...new Set([...result.unverified.values()].map((entry) => entry.reason))]
  const detail = reasons.join(', ')
  if (result.status === 'partial') {
    warn(logger, `prompt order calibrated for ${result.verified.size}/${requested} section(s); ` +
      `${result.unverified.size} left without a verified order (${detail})`)
  } else if (result.status === 'failed') {
    warn(logger, `order calibration aborted (${result.reason ?? 'assembly-failed'}); ` +
      `${requested} section(s) keep the official order`)
  } else {
    warn(logger, `order calibration did not converge for ${requested} section(s) (${detail})`)
  }
}

/** Resolve the numeric order of every captured section, once per name set. */
async function resolveOrders (agent, prompt, rows, orderCache, logger) {
  const introspected = introspectOrders(agent, prompt)
  // Include the registry order when we can read it: two sessions can expose the
  // same section names while a preset gives one of them a different placement.
  const key = rows
    .map((row) => `${row.name}@${introspected?.get(row.name) ?? ''}`)
    .join('\n')

  // A partial map must not short-circuit resolution: the missing names would
  // keep the official text forever even after a later attach could verify them.
  const cached = orderCache.get(key)
  if (cached !== undefined && rows.every((row) => Number.isFinite(cached.get(row.name)))) {
    return new Map(cached)
  }

  const orders = new Map()
  const missing = []
  for (const row of rows) {
    const fromRegistry = introspected?.get(row.name)
    const order = Number.isFinite(fromRegistry) ? fromRegistry : staticOrder(prompt, row.name)
    if (Number.isFinite(order)) orders.set(row.name, order)
    else missing.push(row.name)
  }

  let calibration = null
  if (missing.length > 0) {
    try {
      calibration = await calibrateOrders(agent, prompt, rows, missing)
      for (const [name, order] of calibration.verified) orders.set(name, order)
      reportCalibration(logger, calibration, missing.length)
    } catch (error) {
      warn(logger, `order calibration failed: ${error?.message ?? error}`)
    }
  }

  // Cache only a complete resolution that did not rely on an unverified guess.
  // A failed calibration is retried by the next attach instead of sticking.
  const resolved = rows.every((row) => Number.isFinite(orders.get(row.name)))
  const cacheable = resolved && (calibration === null || calibration.status === 'ok')
  if (cacheable) {
    orderCache.set(key, orders)
    while (orderCache.size > ORDER_CACHE_LIMIT) {
      orderCache.delete(orderCache.keys().next().value)
    }
  }
  return new Map(orders)
}

export function createEngine ({ store, logger, releaseOf, presetOf, readOnlySection, isDraftSession }) {
  const isReadOnly = typeof readOnlySection === 'function' ? readOnlySection : isReadOnlySection
  /** @type {Map<string, any>} live per-session runtime (agent ctx, baseline, registrations) */
  const runtimes = new Map()
  /** @type {Map<string, object | null>} last capture delta, kept in memory only */
  const capturedDelta = new Map()
  /** @type {Map<string, Map<string, number>>} order cache keyed by section-name set */
  const orderCache = new Map()
  /** @type {Map<string, Set<string>>} tool-policy suppression, kept across agent rebuilds */
  const suppressedSections = new Map()
  /** @type {Map<string, Promise<any>>} serializes attach() per session */
  const locks = new Map()
  const version = () => {
    try {
      const value = typeof releaseOf === 'function' ? releaseOf() : null
      return typeof value === 'string' && value !== '' ? value : null
    } catch {
      return null
    }
  }

  function withLock (sessionId, fn) {
    const previous = locks.get(sessionId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const tail = run.then(() => undefined, () => undefined)
    locks.set(sessionId, tail)
    void tail.then(() => {
      if (locks.get(sessionId) === tail) locks.delete(sessionId)
    })
    return run
  }

  /** name -> {mode, text, baseHash, fragmentId, label} for the session's saved overrides. */
  function rules (sessionId, state) {
    const locked = store.lockedSnapshot(sessionId)
    const map = new Map()
    for (const [name, fragmentId] of Object.entries(state.overrides ?? {})) {
      // Tool/capability protocol sections are read-only. A stale override from
      // an older version must never be registered, even if the state file has
      // not been cleaned yet.
      if (isReadOnly(name)) continue
      if (locked !== null) {
        const row = locked.sections.find((section) => section.name === name)
        if (row === undefined) continue
        map.set(name, {
          mode: row.mode === 'empty' ? 'empty' : 'replace',
          text: typeof row.text === 'string' ? row.text : '',
          baseHash: null,
          awaitingBaseline: false,
          fragmentId: typeof row.fragmentId === 'string' ? row.fragmentId : fragmentId,
          label: typeof row.label === 'string' ? row.label : ''
        })
        continue
      }
      const byId = new Map(store.libraryFor(sessionId).fragments.map((fragment) => [fragment.id, fragment]))
      const fragment = byId.get(fragmentId)
      if (fragment === undefined) continue
      map.set(name, {
        mode: fragment.mode === 'empty' ? 'empty' : 'replace',
        text: typeof fragment.text === 'string' ? fragment.text : '',
        baseHash: typeof fragment.baseHash === 'string' ? fragment.baseHash : null,
        awaitingBaseline: fragment.awaitingBaseline === true,
        fragmentId: fragment.id,
        label: typeof fragment.label === 'string' ? fragment.label : ''
      })
    }
    return map
  }

  function extrasOf (state, sessionId) {
    const locked = store.lockedSnapshot(sessionId)
    if (locked !== null) {
      return locked.sections
        .filter((section) => section && section.status === 'extra' && typeof section.name === 'string')
        .map((section) => ({
          ...section,
          text: typeof section.text === 'string' ? section.text : '',
          anchor: section.anchor ?? '__end__',
          order: Number(section.order) || 0
        }))
        .sort((a, b) => {
          const delta = (Number(a.order) || 0) - (Number(b.order) || 0)
          if (delta !== 0) return delta
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        })
    }
    return [...(Array.isArray(state.extras) ? state.extras : [])]
      .filter((extra) => extra && typeof extra.name === 'string')
      .map((extra) => ({ ...extra, text: store.sectionTextOf(extra, sessionId) }))
      .sort((a, b) => {
        const delta = (Number(a.order) || 0) - (Number(b.order) || 0)
        if (delta !== 0) return delta
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      })
  }

  function disposeAll (runtime) {
    for (const [name, registration] of runtime.regs) {
      try {
        registration.dispose()
      } catch (error) {
        warn(logger, `cannot dispose "${name}": ${error?.message ?? error}`)
      }
    }
    runtime.regs.clear()
  }

  /**
   * The numeric order for each extra, arranged inside the anchor's gap. The
   * same layout is used by `describe`, so the panel list and the assembled
   * prompt keep one order.
   */
  function extraOrders (runtime, extras) {
    const officialNames = new Set(runtime.baseline.rows.map((row) => row.name))
    const rows = runtime.baseline.rows
    const groups = new Map()
    for (const extra of extras) {
      if (officialNames.has(extra.name)) continue
      const anchor = normalizeAnchor(anchorOf(extra), officialNames)
      const list = groups.get(anchor) ?? []
      list.push(extra)
      groups.set(anchor, list)
    }

    const result = new Map()
    for (const [anchor, list] of groups) {
      let base = 9000
      let next = null
      if (anchor === ANCHOR_START) {
        const first = rows.length > 0 ? runtime.orders.get(rows[0].name) : null
        base = (Number.isFinite(first) ? first : 9000) - 1000
        next = Number.isFinite(first) ? first : null
      } else if (anchor === ANCHOR_END) {
        const last = rows.length > 0 ? runtime.orders.get(rows[rows.length - 1].name) : null
        base = (Number.isFinite(last) ? last : 9000) + 1000
        next = null
      } else {
        const index = rows.findIndex((row) => row.name === anchor)
        const own = index >= 0 ? runtime.orders.get(anchor) : null
        base = Number.isFinite(own) ? own : 9000
        const following = index >= 0 && index + 1 < rows.length ? runtime.orders.get(rows[index + 1].name) : null
        next = Number.isFinite(following) ? following : null
      }
      const span = next !== null && next > base ? next - base : 1000
      const step = span / (list.length + 2)
      list.forEach((extra, at) => result.set(extra.name, base + step * (at + 1)))
    }
    return result
  }

  /** Reconcile the live registrations with what the stored state currently wants. */
  function sync (sessionId) {
    const runtime = runtimes.get(String(sessionId))
    if (runtime === undefined) return false
    try {
      const state = store.stateFor(sessionId)
      if (state.enabled !== true || runtime.completeActive) {
        disposeAll(runtime)
        return true
      }

      const officialNames = new Set(runtime.baseline.rows.map((row) => row.name))
      const byName = new Map(runtime.baseline.rows.map((row) => [row.name, row]))
      const desired = new Map()

      for (const [name, rule] of rules(sessionId, state)) {
        const row = byName.get(name)
        if (row === undefined) continue // orphan: nothing to shadow
        if (rule.awaitingBaseline) continue // saved before a baseline existed; wait for a pin
        if (rule.baseHash !== null && rule.baseHash !== row.hash) continue // suspended: keep official text
        const order = runtime.orders.get(name)
        if (!Number.isFinite(order)) continue
        desired.set(name, {
          order,
          text: rule.mode === 'empty' ? '' : rule.text,
          kind: 'override'
        })
      }

      const extras = extrasOf(state, sessionId)
      const orders = extraOrders(runtime, extras)
      for (const section of extras) {
        if (officialNames.has(section.name)) continue // would collide with the official name
        const order = orders.get(section.name)
        if (!Number.isFinite(order)) continue
        desired.set(section.name, {
          order,
          text: section.text,
          kind: 'extra'
        })
      }

      // Tool switches hide only exact same-name `tool:<tool>` sections. This
      // is deliberately a best-effort mapping: the tool registry does not
      // expose a section-name relation.
      for (const name of runtime.suppressed ?? []) {
        if (!officialNames.has(name)) continue
        const order = runtime.orders.get(name)
        if (!Number.isFinite(order)) continue
        desired.set(name, { order, text: '', kind: 'suppress' })
      }

      for (const [name, registration] of [...runtime.regs]) {
        const want = desired.get(name)
        if (want === undefined || want.order !== registration.order || want.text !== registration.text) {
          try {
            registration.dispose()
          } catch (error) {
            warn(logger, `cannot dispose "${name}": ${error?.message ?? error}`)
          }
          runtime.regs.delete(name)
        }
      }

      for (const [name, want] of desired) {
        if (runtime.regs.has(name)) continue
        try {
          const dispose = runtime.ctx.systemPrompt.section({
            name,
            order: want.order,
            text: want.text,
            interpolate: false
          })
          runtime.regs.set(name, { dispose, order: want.order, text: want.text, kind: want.kind })
        } catch (error) {
          warn(logger, `cannot register section "${name}" (maybe already owned by another scoped plugin): ${error?.message ?? error}`)
        }
      }
      return true
    } catch (error) {
      warn(logger, `live section sync failed, official prompt kept: ${error?.message ?? error}`)
      return false
    }
  }

  /** One empty probe: a complete preset forces `sections` down to a single entry. */
  async function detectComplete (agent, prompt, context) {
    let dispose
    try {
      dispose = agent.ctx.systemPrompt.section({
        name: `prompt-lab:sentinel:${Date.now()}`,
        order: SENTINEL_ORDER,
        text: '',
        interpolate: false
      })
      const probe = await prompt.assemble(context)
      if (!Array.isArray(probe?.sections)) return false
      return !probe.sections.some((section) => typeof section?.name === 'string' && section.name.startsWith('prompt-lab:sentinel:'))
    } catch (error) {
      warn(logger, `complete detection failed, assuming a normal preset: ${error?.message ?? error}`)
      return false
    } finally {
      try {
        dispose?.()
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Probe the official assembly. PTC executors render their SDK guidance from
   * the step's admitted tool set; a bare assemble can throw before the first
   * step exists. Retry that case with the same selection/toolSet the loop uses.
   */
  async function probeAssembly (agent, prompt) {
    const base = { agent, scope: agent }
    try {
      return { assembly: await prompt.assemble(base), context: base, toolSet: null }
    } catch (firstError) {
      const selection = typeof agent?.model?.current === 'function' ? agent.model.current() : undefined
      const tools = agent?.ctx?.tools
      if (selection === undefined || typeof tools?.resolve !== 'function') throw firstError
      let toolSet
      try {
        const controller = new AbortController()
        toolSet = await tools.resolve({ agent, modelSelection: selection, signal: controller.signal })
        const context = { ...base, modelSelection: selection, toolSet }
        const assembly = await prompt.assemble(context)
        return { assembly, context, toolSet }
      } catch (fallbackError) {
        try {
          toolSet?.dispose()
        } catch {
          /* ignore */
        }
        const combined = new Error(
          `step-tool retry failed: ${fallbackError?.message ?? fallbackError}; original: ${firstError?.message ?? firstError}`
        )
        combined.cause = fallbackError
        combined.stack = `${combined.message}\n${fallbackError?.stack ?? ''}\n${firstError?.stack ?? ''}`
        warn(logger, `baseline probe without step tools failed (${firstError?.message ?? firstError}); retry with step tools also failed: ${fallbackError?.message ?? fallbackError}`)
        throw combined
      }
    }
  }

  function recordCapture (sessionId, rows, fingerprint) {
    const state = store.stateFor(sessionId)
    const previous = state.lastCapture ?? null
    const names = rows.map((row) => row.name).sort()
    const current = version()
    const delta = previous === null || !Array.isArray(previous.names)
      ? { firstCapture: true, added: [], removed: [], version: current }
      : {
          firstCapture: false,
          added: names.filter((name) => !previous.names.includes(name)),
          removed: previous.names.filter((name) => !names.includes(name)),
          version: current
        }
    capturedDelta.set(String(sessionId), delta)
    // Draft sessions deliberately do not persist a capture baseline: their
    // state is not a formal session yet, and the baseline belongs to the
    // runtime sample, not to the global store. Sampling must not create a
    // formal `sessions/<id>/state.json` either, or the window would stop being
    // a draft before its first edit.
    let draft = false
    try {
      draft = typeof store.hasDraft === 'function' && store.hasDraft(sessionId)
      if (!draft && typeof isDraftSession === 'function') draft = isDraftSession(sessionId) === true
    } catch {
      draft = false
    }
    if (draft) return
    try {
      store.saveState(sessionId, {
        ...state,
        lastCapture: { version: current, at: Date.now(), names },
        // Persist the assembly identity so the assembly overview can tell a
        // cached view from a newer runtime capture.
        ...(typeof fingerprint === 'string' ? { structureHash: fingerprint } : {})
      })
    } catch (error) {
      warn(logger, `cannot persist the capture baseline: ${error?.message ?? error}`)
    }
  }

  /**
   * Best-effort agent-preset identity for the read-only complete view. A
   * missing service, a preset-free agent, or a throwing lookup all degrade to
   * an empty identity; this value is descriptive only.
   */
  async function presetInfo (agent) {
    try {
      const value = typeof presetOf === 'function' ? await presetOf(agent) : null
      if (value === null || typeof value !== 'object') return { id: null, name: null }
      return {
        id: typeof value.id === 'string' ? value.id : null,
        name: typeof value.name === 'string' ? value.name : null
      }
    } catch {
      return { id: null, name: null }
    }
  }

  /**
   * Sample the official assembly and (re)install registrations. Must run before
   * any override exists; with `force` the current registrations are removed
   * first, which is how the panel asks for a fresh official baseline.
   */
  async function attach (agent, options = {}) {
    const sessionId = String(agent?.id ?? '')
    if (sessionId === '') return { ok: false, reason: 'no-agent' }
    const prompt = promptOf(agent)
    if (prompt === null) return { ok: false, reason: 'no-system-prompt' }

    const existing = runtimes.get(sessionId)
    if (existing !== undefined && existing.agent === agent && options.force !== true) {
      sync(sessionId)
      return { ok: true, sections: existing.baseline.rows.length, completeActive: existing.completeActive }
    }

    return withLock(sessionId, async () => {
      const runtime = runtimes.get(sessionId)
      if (runtime !== undefined) disposeAll(runtime)
      runtimes.delete(sessionId)

      try {
        const probe = await probeAssembly(agent, prompt)
        try {
          const assembly = probe.assembly
          const rows = toRows(assembly?.sections)
          const fingerprint = fingerprintOf(rows)
          const completeActive = await detectComplete(agent, prompt, probe.context)
          const orders = await resolveOrders(agent, prompt, rows, orderCache, logger)
          const preset = await presetInfo(agent)
          const next = {
            agent,
            ctx: agent.ctx,
            prompt,
            completeActive,
            preset,
            baseline: {
              at: Date.now(),
              rows,
              fingerprint,
              officialNames: rows.map((row) => row.name)
            },
            orders,
            regs: new Map(),
            suppressed: suppressedSections.get(sessionId) ?? new Set()
          }
          runtimes.set(sessionId, next)
          recordCapture(sessionId, rows, fingerprint)
          // A draft template saved before this Agent existed has no baseline
          // hash yet. Pin it now, before sync decides whether it may apply.
          try {
            if (typeof store.pinDraftBaselines === 'function') store.pinDraftBaselines(sessionId, rows)
          } catch (error) {
            warn(logger, `cannot pin draft baselines: ${error?.message ?? error}`)
          }
          sync(sessionId)
          return { ok: true, sections: rows.length, completeActive }
        } finally {
          try {
            probe.toolSet?.dispose()
          } catch {
            /* best-effort admission release */
          }
        }
      } catch (error) {
        const diagnostics = diagnoseProbeError(error)
        warn(logger, `baseline probe failed, official prompt kept: ${diagnostics.detail}`)
        return { ok: false, reason: 'probe-failed', detail: diagnostics.detail, attribution: diagnostics }
      }
    })
  }

  /**
   * Store the exact tool-section names hidden by the session's tool policy.
   * Pending sets survive agent rebuilds; a live runtime is synced immediately.
   */
  function setSuppressedSections (sessionId, names) {
    const id = String(sessionId)
    const set = new Set(Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name !== '') : [])
    if (set.size === 0) suppressedSections.delete(id)
    else suppressedSections.set(id, set)
    const runtime = runtimes.get(id)
    if (runtime !== undefined) {
      runtime.suppressed = set
      sync(id)
    }
    return true
  }

  function detach (sessionId, agent) {
    const id = String(sessionId)
    const runtime = runtimes.get(id)
    if (runtime === undefined) return
    // A resumed/cleared session can create a new Agent before the old one's
    // disposal event arrives; never let the old disposal tear down the new one.
    if (agent !== undefined && runtime.agent !== agent) return
    disposeAll(runtime)
    runtimes.delete(id)
  }

  function forget (sessionId) {
    detach(sessionId)
    capturedDelta.delete(String(sessionId))
  }

  /**
   * Reconcile every live runtime. A fragment, section text or tool switch is
   * global; a mutation triggered from one session must not leave another live
   * session on stale registered text.
   */
  function syncAll () {
    for (const sessionId of [...runtimes.keys()]) sync(sessionId)
  }

  function shutdown () {
    for (const sessionId of [...runtimes.keys()]) detach(sessionId)
    capturedDelta.clear()
    orderCache.clear()
    suppressedSections.clear()
  }

  /**
   * Everything the panel needs, in **assembly order**: official sections with
   * user-added sections interleaved at the anchor they were saved under. The
   * UI renders this list as-is, so moving a section up/down in the panel is
   * the same order the model receives.
   */
  function describe (sessionId) {
    const id = String(sessionId)
    const state = store.stateFor(id)
    const runtime = runtimes.get(id)
    const active = rules(id, state)
    const baselineRows = runtime?.baseline.rows ?? []
    const officialByName = new Map(baselineRows.map((row, index) => [row.name, index]))
    const officialNames = baselineRows.map((row) => row.name)
    const officialSet = new Set(officialNames)
    const completeActive = runtime?.completeActive === true

    const officialRows = baselineRows.map((row) => {
      const rule = active.get(row.name)
      const pending = rule?.awaitingBaseline === true
      const effective = rule === undefined
        ? true
        : !pending && (rule.baseHash === null || rule.baseHash === row.hash)
      const status = rule === undefined ? 'official' : pending ? 'pending' : effective ? 'active' : 'suspended'
      const toolSuppressed = runtime?.suppressed?.has?.(row.name) === true
      const text = toolSuppressed ? '' : rule === undefined ? row.text : rule.mode === 'empty' ? '' : rule.text
      return {
        name: row.name,
        status,
        mode: rule?.mode ?? 'replace',
        fragmentId: rule?.fragmentId ?? null,
        fragmentLabel: rule?.label ?? null,
        order: runtime?.orders.get(row.name) ?? null,
        officialText: row.text,
        officialHash: row.hash,
        text,
        tokens: estimateTokens(text),
        officialTokens: estimateTokens(row.text),
        source: sectionSource(row.name),
        sensitivity: sensitivityOf(row.name),
        readOnly: isReadOnlySection(row.name),
        toolSuppressed,
        applied: rule === undefined || pending ? null : runtime?.regs.has(row.name) === true
      }
    })

    const orphanRows = []
    for (const [name, rule] of active) {
      if (officialByName.has(name)) continue
      const status = runtime === undefined ? 'unknown' : completeActive ? 'blocked' : 'orphan'
      orphanRows.push({
        name,
        status,
        mode: rule.mode,
        fragmentId: rule.fragmentId,
        fragmentLabel: rule.label,
        officialText: '',
        officialHash: null,
        text: rule.mode === 'empty' ? '' : rule.text,
        tokens: estimateTokens(rule.mode === 'empty' ? '' : rule.text),
        officialTokens: 0,
        source: sectionSource(name),
        sensitivity: sensitivityOf(name),
        readOnly: isReadOnlySection(name)
      })
    }

    const extraRows = []
    const seen = new Set()
    for (const extra of extrasOf(state, id)) {
      if (officialByName.has(extra.name) || seen.has(extra.name)) continue
      seen.add(extra.name)
      const rawAnchor = anchorOf(extra)
      const anchor = normalizeAnchor(rawAnchor, officialSet)
      const linked = typeof extra.textId === 'string' ? store.fragmentById(extra.textId, id) : undefined
      extraRows.push({
        name: extra.name,
        status: 'extra',
        mode: 'replace',
        fragmentId: null,
        fragmentLabel: null,
        textId: typeof extra.textId === 'string' ? extra.textId : null,
        textLabel: linked?.label ?? null,
        officialText: '',
        officialHash: null,
        text: extra.text,
        tokens: estimateTokens(extra.text),
        officialTokens: 0,
        source: null,
        sensitivity: null,
        readOnly: false,
        extraId: String(extra.id ?? ''),
        anchor: rawAnchor,
        order: Number(extra.order) || 0,
        anchorMissing: rawAnchor !== ANCHOR_START && rawAnchor !== ANCHOR_END && !officialSet.has(rawAnchor),
        // only used for placement below; not exposed to the client
        _anchor: anchor
      })
    }

    const byAnchor = new Map()
    for (const row of extraRows) {
      const list = byAnchor.get(row._anchor) ?? []
      list.push(row)
      byAnchor.set(row._anchor, list)
    }

    const rows = []
    rows.push(...(byAnchor.get(ANCHOR_START) ?? []))
    for (const row of officialRows) {
      rows.push(row)
      rows.push(...(byAnchor.get(row.name) ?? []))
    }
    rows.push(...orphanRows)
    for (const [anchor, list] of byAnchor) {
      if (anchor === ANCHOR_START || officialSet.has(anchor)) continue
      rows.push(...list)
    }

    for (const row of rows) delete row._anchor

    const preset = runtime?.preset ?? { id: null, name: null }
    const completeRow = completeActive ? baselineRows[0] : undefined
    return {
      captured: runtime !== undefined,
      capturedAt: runtime?.baseline.at ?? null,
      fingerprint: runtime?.baseline.fingerprint ?? null,
      officialNames,
      completeActive,
      complete: {
        active: completeActive,
        sectionName: completeRow?.name ?? null,
        text: completeRow?.text ?? '',
        tokens: estimateTokens(completeRow?.text ?? ''),
        presetId: preset.id ?? null,
        presetName: preset.name ?? null
      },
      sections: rows
    }
  }

  function lastDelta (sessionId) {
    return capturedDelta.get(String(sessionId)) ?? null
  }

  return {
    attach,
    detach,
    forget,
    shutdown,
    sync,
    syncAll,
    describe,
    lastDelta,
    setSuppressedSections
  }
}
