/**
 * JSON API behind the Web panel. Served by the Harness's own web server on a
 * prefix route, so the panel talks to the Host over the same origin it was
 * loaded from — no second port, no extra authentication surface.
 */
import { randomBytes } from 'node:crypto'
import { cleanupDataDirs, hasMeaningfulData, migrationPathError, targetHasContents } from './migrate.js'
import {
  CLASSIFIED_AGAINST,
  CONFIG_LIMITS,
  DEFAULT_CONFIG,
  MESSAGE_ENTRY_LIMIT,
  MESSAGE_TEXT_LIMIT,
  SECTION_ACTIVATIONS,
  SESSION_ID,
  bootstrapDir,
  defaultDataDir,
  estimateTokens,
  isReadOnlySection,
  nextDefaultLabel,
  sectionSource,
  sensitivityOf,
  validateDataDir
} from './store.js'

export const ROUTE = '/prompt-lab/api'
const MAX_BODY = 2 * 1024 * 1024
const MAX_TEXT = 200_000

function id (prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

function text (value, max = MAX_TEXT) {
  if (typeof value !== 'string') throw new Error('expected a string')
  if (value.length > max) throw new Error(`value longer than ${max} characters`)
  return value
}

function name (value) {
  const result = text(value, 200).trim()
  if (result === '') throw new Error('name must not be empty')
  if (/[\u0000-\u001f]/.test(result)) throw new Error('name must not contain control characters')
  return result
}

function label (value, fallback = '默认') {
  if (typeof value !== 'string') return fallback
  const result = value.trim()
  if (result === '') return fallback
  if (/[\u0000-\u001f]/.test(result)) throw new Error('label must not contain control characters')
  return result.length > 200 ? result.slice(0, 200) : result
}

function activationOf (value, fallback = 'persistent') {
  return SECTION_ACTIVATIONS.includes(value) ? value : fallback
}

function fragmentSource (key) {
  if (sectionSource(key) === 'official') return 'official'
  return /^(custom:|user:)/.test(key) ? null : 'plugin'
}

function sessionOf (body) {
  const value = String(body?.sessionId ?? '')
  if (!SESSION_ID.test(value)) throw new Error('invalid session id')
  return value
}

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function sortedRecord (value) {
  const source = value && typeof value === 'object' ? value : {}
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, source[key]]))
}

function presetExtrasInput (value) {
  if (!Array.isArray(value)) return null
  return value
    .filter((entry) => entry && typeof entry.name === 'string' && entry.name !== '')
    .map((entry) => ({
      name: entry.name,
      anchor: typeof entry.anchor === 'string' && entry.anchor !== '' ? entry.anchor : '__end__',
      order: Number.isFinite(entry.order) ? entry.order : 0,
      textId: typeof entry.textId === 'string' && entry.textId !== '' ? entry.textId : null
    }))
}

function presetTransientInput (value) {
  if (!Array.isArray(value)) return null
  return value
    .filter((entry) => entry && typeof entry.name === 'string' && entry.name !== '')
    .map((entry) => ({
      name: entry.name,
      anchor: typeof entry.anchor === 'string' && entry.anchor !== '' ? entry.anchor : '__end__',
      order: Number.isFinite(entry.order) ? entry.order : 0,
      activation: 'once',
      enabled: entry.enabled !== false,
      textId: typeof entry.textId === 'string' && entry.textId !== '' ? entry.textId : null
    }))
}

/**
 * @param {object} options
 * @param {import('./store.js').Store} options.store
 * @param {ReturnType<import('./engine.js').createEngine>} options.engine
 * @param {string} options.dataDir effective data directory (startup value)
 * @param {string[]} options.warnings
 * @param {(sessionId: string) => Promise<object>} [options.captureNow]
 * @param {(sessionId: string) => object | undefined} [options.agentOf]
 * @param {() => string | null} [options.releaseOf] DSH release version, when known
 * @param {(ids: string[]) => Promise<Map<string, {id:string,status:string,title:string|null}>>} [options.livenessOf]
 * @param {(name: string) => boolean} [options.readOnlySection] override for tests
 * @param {(sessionId: string) => object} [options.toolsList]
 * @param {(sessionId: string) => void} [options.onToolPolicyChanged]
 * @param {(sessionId: string) => object} [options.instructionsOf]
 * @param {(sessionId: string, text: string) => Promise<object>} [options.appendUserMessage]
 * @param {(sessionId: string, text: string) => Promise<object>} [options.appendAssistantMessage]
 * @param {(sessionId: string, id?: string) => void} [options.onTransientChanged]
 * @param {(sessionId: string, text: string, assistantText?: string) => Promise<object>} [options.prefillSend]
 * @param {(sessionId: string) => object} [options.pendingStatus]
 * @param {(sessionId: string) => object} [options.pendingUnlock]
 * @param {() => object} options.settings live bootstrap config
 * @param {(patch: object) => object} options.saveSettings persist + apply
 */
export function createApi ({ store, engine, dataDir, dataDirSource, warnings, captureNow, agentOf, releaseOf, livenessOf, readOnlySection, isDraftSession, toolsList, onToolPolicyChanged, instructionsOf, appendUserMessage, appendAssistantMessage, onTransientChanged, prefillSend, pendingStatus, pendingUnlock, settings, saveSettings, wipeAllData, isPromptLocked, lockSession, purgeSessionData, agentPresets }) {
  const isReadOnly = typeof readOnlySection === 'function' ? readOnlySection : isReadOnlySection
  const releaseVersion = () => {
    try {
      const value = typeof releaseOf === 'function' ? releaseOf() : null
      return typeof value === 'string' && value !== '' ? value : null
    } catch {
      return null
    }
  }
  const liveness = async (ids) => {
    const unique = [...new Set(ids.map(String))]
    if (typeof livenessOf !== 'function') {
      return new Map(unique.map((id) => [id, { id, status: 'unknown', title: null }]))
    }
    try {
      const result = await livenessOf(unique)
      return result instanceof Map
        ? result
        : new Map(unique.map((id) => [id, { id, status: 'unknown', title: null }]))
    } catch {
      return new Map(unique.map((id) => [id, { id, status: 'unknown', title: null }]))
    }
  }
  const settingsOf = () => (typeof settings === 'function' ? settings() : { ...DEFAULT_CONFIG })
  const toolsOf = (sessionId) => {
    if (typeof toolsList !== 'function') return { enabled: false, hasAgent: false, policy: { deny: [] }, tools: [] }
    try {
      return toolsList(sessionId)
    } catch {
      return { enabled: false, hasAgent: false, policy: { deny: [] }, tools: [] }
    }
  }
  const toolPolicyChanged = (sessionId) => {
    if (typeof onToolPolicyChanged !== 'function') return
    try {
      onToolPolicyChanged(sessionId)
    } catch {
      /* policy application is fail-open */
    }
  }
  const instructions = (sessionId) => {
    if (typeof instructionsOf !== 'function') {
      return { ok: false, reason: 'unavailable', cwd: null, files: [], notes: [] }
    }
    try {
      return instructionsOf(sessionId)
    } catch (error) {
      return { ok: false, reason: 'read-failed', cwd: null, files: [], notes: [String(error?.message ?? error)] }
    }
  }
  const assemblyOverview = (sessionId) => {
    const described = engine.describe(sessionId)
    const state = store.stateFor(sessionId)
    const toolList = toolsOf(sessionId)
    const instructionList = instructions(sessionId)
    const rows = Array.isArray(described.sections) ? described.sections : []
    const tools = Array.isArray(toolList.tools) ? toolList.tools : []
    const files = Array.isArray(instructionList.files) ? instructionList.files : []
    const effectiveTokens = (row) => {
      if (row?.toolSuppressed === true) return 0
      if (row?.status === 'active') return Number(row.tokens) || 0
      if (row?.status === 'suspended' || row?.status === 'pending') return Number(row.officialTokens) || 0
      if (row?.status === 'extra') return Number(row.tokens) || 0
      if (row?.status === 'transient') return row.active === true ? Number(row.tokens) || 0 : 0
      if (row?.status === 'official') return Number(row.officialTokens) || 0
      return 0
    }
    const tokens = described.completeActive === true
      ? Number(described.complete?.tokens) || 0
      : rows.reduce((sum, row) => sum + effectiveTokens(row), 0)
    let history = { available: false, count: null }
    try {
      const messages = agentOf(sessionId)?.session?.deriveMessages?.()
      if (Array.isArray(messages)) history = { available: true, count: messages.length }
    } catch {
      /* history is optional; the overview still works */
    }
    return {
      captured: described.captured === true,
      completeActive: described.completeActive === true,
      classifiedAgainst: CLASSIFIED_AGAINST,
      structureHash: described.fingerprint ?? state?.structureHash ?? null,
      systemPrompt: {
        sectionCount: described.completeActive === true ? 1 : rows.length,
        officialCount: Array.isArray(described.officialNames) ? described.officialNames.length : 0,
        overrideCount: rows.filter((row) => row.fragmentId != null || row.mode === 'empty').length,
        emptyCount: rows.filter((row) => row.mode === 'empty').length,
        extraCount: rows.filter((row) => row.status === 'extra').length,
        transientCount: rows.filter((row) => row.status === 'transient').length,
        tokens
      },
      tools: {
        count: tools.length,
        visible: tools.filter((tool) => tool.visible === true).length,
        denied: tools.filter((tool) => tool.denied === true).length,
        hasAgent: toolList.hasAgent === true,
        enabled: toolList.enabled === true
      },
      runtimeContext: {
        available: false,
        description: '工作目录、沙箱、审批、时间等由 DSH 注入。'
      },
      instructions: {
        available: instructionList.ok === true,
        files: files.length,
        bytes: files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0),
        truncated: files.some((file) => file.truncated === true),
        cwd: instructionList.cwd ?? null
      },
      history,
      currentInput: {
        available: false,
        description: '本轮用户输入和附件由 DSH 直接提供。'
      }
    }
  }
  const appendUser = async (sessionId, value) => {
    if (typeof appendUserMessage !== 'function') return { ok: false, reason: 'unavailable' }
    try {
      return await appendUserMessage(sessionId, value)
    } catch (error) {
      return { ok: false, reason: 'append-failed', detail: String(error?.message ?? error) }
    }
  }
  const appendAssistant = async (sessionId, value) => {
    if (typeof appendAssistantMessage !== 'function') return { ok: false, reason: 'unavailable' }
    try {
      return await appendAssistantMessage(sessionId, value)
    } catch (error) {
      return { ok: false, reason: 'append-failed', detail: String(error?.message ?? error) }
    }
  }
  const sendPrefill = async (sessionId, value, assistantText) => {
    if (typeof prefillSend !== 'function') return { ok: false, reason: 'unavailable' }
    try {
      return await prefillSend(sessionId, value, assistantText)
    } catch (error) {
      return { ok: false, reason: 'send-failed', detail: String(error?.message ?? error) }
    }
  }
  const notifyTransientChanged = (sessionId, id) => {
    if (typeof onTransientChanged !== 'function') return
    try {
      onTransientChanged(sessionId, id)
    } catch {
      /* fail-open: state is already saved */
    }
  }
  const persist = (patch) => {
    if (typeof saveSettings !== 'function') throw new Error('settings are read-only')
    return saveSettings(patch)
  }

  const draftOf = (sessionId) => (typeof store.draft === 'function' ? store.draft(sessionId) : null)
  const isDraft = (sessionId) => draftOf(sessionId) !== null

  /**
   * A not-yet-started window may only open a draft when no formal state exists.
   * `isDraftSession` is supplied by the Host (turnBoundary-based); without it
   * (tests, older wiring) drafts are used only when they already exist.
   */
  const draftContext = (sessionId) => {
    if (isDraft(sessionId)) return true
    if (store.hasFormalState(sessionId)) return false
    try {
      return typeof isDraftSession === 'function' && isDraftSession(sessionId) === true
    } catch {
      return false
    }
  }

  const ensureDraft = (sessionId) => {
    if (isDraft(sessionId)) return true
    if (!draftContext(sessionId)) return false
    store.ensureDraft(sessionId)
    return true
  }

  const stateOf = (sessionId) => clone(store.stateFor(sessionId))
  const promptLocked = (sessionId) => typeof isPromptLocked === 'function' && isPromptLocked(sessionId) === true
  const assertPromptEditable = (sessionId) => {
    if (promptLocked(sessionId)) {
      throw new Error('本会话已开始首轮，提示词已锁定；请新建会话后配置。')
    }
  }

  /**
   * A user-added section must not shadow an official section or an existing
   * override. The engine would silently keep one of the two and the panel
   * would show a row that can never apply.
   * @param {string} sessionId
   * @param {string} value
   */
  function assertInsertNameAvailable (sessionId, value) {
    if (isReadOnly(value) || sectionSource(value) === 'official') {
      throw new Error('这是官方段；请改写官方段，不能作为新增段')
    }
    const described = engine.describe(sessionId)
    if ((described.officialNames ?? []).includes(value)) {
      throw new Error('已有同名官方段，不能作为新增段')
    }
    if ((store.stateFor(sessionId).overrides ?? {})[value] !== undefined) {
      throw new Error('已有同名覆盖段，不能作为新增段')
    }
  }

  const saveStateOf = (sessionId, state) => {
    const draft = draftOf(sessionId)
    if (draft === null) return store.saveState(sessionId, state)
    const now = Date.now()
    const next = {
      ...draft.state,
      ...state,
      committed: false,
      updatedAt: now
    }
    if (!Number.isFinite(next.firstSeenAt) || next.firstSeenAt === 0) next.firstSeenAt = now
    next.lastSeenAt = now
    store.saveDraft(sessionId, { ...draft, state: next })
    return store.draft(sessionId).state
  }

  const libraryOf = (sessionId) => clone(store.libraryFor(sessionId))

  const saveLibraryOf = (sessionId, library) => {
    const draft = draftOf(sessionId)
    if (draft === null) return store.saveLibrary(library)
    const draftIds = new Set(draft.fragments.map((fragment) => fragment.id))
    const nextDraft = []
    const nextGlobal = []
    for (const fragment of library.fragments ?? []) {
      if (draftIds.has(fragment.id) || String(fragment.id).startsWith('frag_draft_')) nextDraft.push(fragment)
      else nextGlobal.push(fragment)
    }
    const global = store.library()
    if (JSON.stringify(global.fragments) !== JSON.stringify(nextGlobal)) {
      store.saveLibrary({ version: global.version, fragments: nextGlobal })
    }
    store.saveDraft(sessionId, { ...draft, fragments: nextDraft })
    return store.libraryFor(sessionId)
  }

  const backupOf = (sessionId, label, kind) => {
    if (isDraft(sessionId) || promptLocked(sessionId)) return null
    return store.backup(sessionId, label, kind)
  }

  /**
   * P6: a non-empty session section is backed by a section text entry. Official
   * overrides use fragment.save; extras/transients use this resolver so the
   * panel row becomes a reference, not a private copy. Editing a referenced
   * entry's text updates it in place (the same rule as an official template).
   */
  function ensureInsertText (key, value, activation, currentId) {
    if (value.trim() === '') return { textId: null, entry: null, changed: false, kind: 'empty' }
    const library = clone(store.library())
    const current = typeof currentId === 'string'
      ? library.fragments.find((fragment) => fragment.id === currentId && fragment.target === 'insert')
      : undefined
    const exact = library.fragments.find((fragment) =>
      fragment.target === 'insert' &&
      fragment.key === key &&
      fragment.mode === 'replace' &&
      fragment.text === value)
    if (exact !== undefined) {
      return { textId: exact.id, entry: exact, changed: false, kind: current?.id === exact.id ? 'unchanged' : 'mapped' }
    }
    const now = Date.now()
    if (current !== undefined) {
      current.text = value
      current.updatedAt = now
      store.saveLibrary(library)
      return { textId: current.id, entry: current, changed: true, kind: 'updated' }
    }
    const entry = {
      id: id('frag'),
      key,
      label: nextDefaultLabel(library.fragments),
      mode: 'replace',
      target: 'insert',
      activation: activationOf(activation),
      text: value,
      baseHash: null,
      baseText: '',
      createdAt: now,
      updatedAt: now
    }
    library.fragments.push(entry)
    store.saveLibrary(library)
    return { textId: entry.id, entry, changed: true, kind: 'created' }
  }

  /** P6: prefill fixed text is a persistent reference to one message text entry. */
  function ensureMessageText (value, currentId) {
    if (value.trim() === '') return { textId: null, entry: null, changed: false, kind: 'empty' }
    const library = clone(store.messageLibrary())
    const current = typeof currentId === 'string'
      ? library.entries.find((entry) => entry.id === currentId)
      : undefined
    const exact = library.entries.find((entry) => entry.text === value)
    if (exact !== undefined) {
      return { textId: exact.id, entry: exact, changed: false, kind: current?.id === exact.id ? 'unchanged' : 'mapped' }
    }
    const now = Date.now()
    if (current !== undefined) {
      current.text = value
      current.updatedAt = now
      store.saveMessageLibrary(library)
      return { textId: current.id, entry: current, changed: true, kind: 'updated' }
    }
    if (library.entries.length >= MESSAGE_ENTRY_LIMIT) {
      throw new Error(`消息文本数量已达上限（${MESSAGE_ENTRY_LIMIT}）`)
    }
    const entry = {
      id: id('msg'),
      label: nextDefaultLabel(library.entries),
      text: value,
      createdAt: now,
      updatedAt: now
    }
    library.entries.push(entry)
    store.saveMessageLibrary(library)
    return { textId: entry.id, entry, changed: true, kind: 'created' }
  }

  function sectionEntryView (fragment) {
    return {
      id: fragment.id,
      key: fragment.key,
      label: fragment.label ?? '',
      mode: fragment.mode === 'empty' ? 'empty' : 'replace',
      target: fragment.target === 'insert' ? 'insert' : 'override',
      activation: activationOf(fragment.activation),
      text: fragment.text ?? '',
      tokens: estimateTokens(fragment.text ?? ''),
      updatedAt: fragment.updatedAt ?? 0
    }
  }

  /** Best-effort library write after a message action already succeeded. */
  function rememberMessageText (value) {
    try {
      ensureMessageText(value)
    } catch {
      /* the session write is authoritative; the library can be filled later */
    }
  }

  function snapshot (sessionId) {
    const draft = draftOf(sessionId)
    const pendingDraft = draft === null && draftContext(sessionId)
    const draftActive = draft !== null || pendingDraft
    const state = store.stateFor(sessionId)
    const library = store.libraryFor(sessionId)
    const allBackups = draftActive ? [] : store.listBackups(sessionId)
    const limits = settingsOf()
    const described = engine.describe(sessionId)
    const lastPreset = state.lastPreset ?? null
    const currentPreset = currentPresetOf(sessionId, state, described)
    const draftIds = new Set(draft === null ? [] : draft.fragments.map((fragment) => fragment.id))
    return {
      session: {
        id: sessionId,
        enabled: state.enabled === true,
        locked: promptLocked(sessionId),
        lockedAt: store.lockedSnapshot(sessionId)?.lockedAt ?? null,
        updatedAt: state.updatedAt ?? 0,
        structureHash: state.structureHash ?? null,
        lastPreset,
        currentPreset,
        presetStats: currentPreset.stats,
        completeActive: described.completeActive === true,
        draft: draftActive,
        committed: !draftActive,
        draftUpdatedAt: draft?.updatedAt ?? null,
        pending: typeof pendingStatus === 'function'
          ? pendingStatus(sessionId)
          : { pending: false, locked: false, status: null, kind: null, syntheticTurn: null }
      },
      prompt: {
        ...described,
        delta: engine.lastDelta(sessionId),
        autoAssistant: {
          enabled: state.autoAssistant?.enabled === true,
          text: store.messageTextOf(state.autoAssistant),
          textId: typeof state.autoAssistant?.textId === 'string' ? state.autoAssistant.textId : null
        }
      },
      library: {
        fragments: library.fragments.map((fragment) => ({
          id: fragment.id,
          key: fragment.key,
          mode: fragment.mode === 'empty' ? 'empty' : 'replace',
          target: fragment.target === 'insert' ? 'insert' : 'override',
          activation: activationOf(fragment.activation),
          text: fragment.text ?? '',
          baseHash: fragment.baseHash ?? null,
          baseText: typeof fragment.baseText === 'string' ? fragment.baseText.slice(0, 4000) : '',
          label: fragment.label ?? '',
          updatedAt: fragment.updatedAt ?? 0,
          tokens: estimateTokens(fragment.text ?? ''),
          sensitivity: sensitivityOf(fragment.key),
          draft: draftIds.has(fragment.id)
        }))
      },
      presets: store.presets().presets.map((preset) => ({
        version: preset.version,
        id: preset.id,
        name: preset.name,
        note: preset.note ?? '',
        fragmentIds: Array.isArray(preset.fragmentIds) ? preset.fragmentIds : [],
        extras: Array.isArray(preset.extras) ? preset.extras : [],
        transientSections: Array.isArray(preset.transientSections) ? preset.transientSections : [],
        toolPolicy: {
          allow: null,
          deny: [...(preset.toolPolicy?.deny ?? [])]
        },
        updatedAt: preset.updatedAt ?? 0
      })),
      backups: {
        auto: allBackups.filter((entry) => entry.kind === 'auto'),
        manual: allBackups.filter((entry) => entry.kind === 'manual'),
        available: !draftActive
      },
      limits: {
        presetLimit: limits.presetLimit ?? DEFAULT_CONFIG.presetLimit,
        autoBackupLimit: limits.autoBackupLimit ?? DEFAULT_CONFIG.autoBackupLimit,
        manualBackupLimit: limits.manualBackupLimit ?? DEFAULT_CONFIG.manualBackupLimit,
        presetCount: store.presets().presets.length,
        bounds: CONFIG_LIMITS
      },
      meta: {
        dataDir,
        bootstrapDir: bootstrapDir(),
        dataDirSource: dataDirSource ?? 'default',
        previousDataDir: settingsOf().previousDataDir ?? null,
        pendingMigration: settingsOf().pendingMigration ?? null,
        warnings: [...warnings],
        captured: described.captured,
        completeActive: described.completeActive === true,
        readonly: store.readonly === true,
        lastCapture: state.lastCapture ?? null,
        draft: draft === null
          ? null
          : {
              createdAt: draft.createdAt,
              updatedAt: draft.updatedAt,
              lastSeenAt: draft.lastSeenAt ?? draft.updatedAt
            },
        release: {
          version: releaseVersion(),
          classifiedAgainst: CLASSIFIED_AGAINST
        }
      }
    }
  }

  function mutate (sessionId, label, fn, kind) {
    backupOf(sessionId, label, kind)
    const state = stateOf(sessionId)
    const next = fn(state) ?? state
    saveStateOf(sessionId, next)
    engine.sync(sessionId)
    return snapshot(sessionId)
  }

  function findCapture (sessionId, key) {
    const described = engine.describe(sessionId)
    return described.sections.find((section) => section.name === key) ?? null
  }

  /**
   * Status counts for the session's CURRENT override mapping, independent of a
   * saved preset source. Manual and source-less configurations still need the
   * same active/suspended/orphan/blocked summary.
   */
  function statsOfCurrent (sessionId, state, described) {
    const byId = new Map(store.libraryFor(sessionId).fragments.map((fragment) => [fragment.id, fragment]))
    const rows = (described ?? engine.describe(sessionId)).sections
    const stats = { active: 0, suspended: 0, orphan: 0, blocked: 0, pending: 0, total: 0 }
    for (const [key, fragmentId] of Object.entries(state.overrides ?? {})) {
      stats.total += 1
      if (!byId.has(fragmentId)) {
        stats.orphan += 1
        continue
      }
      const row = rows.find((section) => section.name === key)
      if (row === undefined) stats.orphan += 1
      else if (row.status === 'suspended') stats.suspended += 1
      else if (row.status === 'active') stats.active += 1
      else if (row.status === 'blocked') stats.blocked += 1
      else if (row.status === 'pending') stats.pending += 1
      else stats.orphan += 1
    }
    return stats
  }

  /**
   * Resolve a preset's fragment ids into one override per section name. A
   * preset may not select two templates for the same key; last-wins would
   * silently drop one, so this throws instead.
   */
  function presetMapping (fragmentIds, sessionId) {
    // Saved presets reference the GLOBAL fragment library only. A draft's
    // private templates may never leak into a global preset.
    const byId = new Map(store.library().fragments.map((fragment) => [fragment.id, fragment]))
    const overrides = {}
    const seen = new Set()
    for (const fragmentId of fragmentIds ?? []) {
      const fragment = byId.get(fragmentId)
      if (fragment === undefined) continue
      if (fragment.target === 'insert' || isReadOnly(fragment.key)) continue
      if (seen.has(fragment.key)) {
        throw new Error(`预设里同一个段名只能选一个模板：${fragment.key}`)
      }
      seen.add(fragment.key)
      overrides[fragment.key] = fragment.id
    }
    return overrides
  }

  /**
   * Resolve a v3 preset's references into concrete session entries. Missing
   * section-text entries are skipped and counted; old presets are not used by
   * this path.
   */
  function resolvePresetConfig (preset, sessionId) {
    const byId = new Map(store.library().fragments.map((fragment) => [fragment.id, fragment]))
    const overrides = presetMapping(preset.fragmentIds, sessionId)
    const extras = []
    const transientSections = []
    const seen = new Set(Object.keys(overrides))
    let unresolved = 0
    for (const entry of preset.extras ?? []) {
      const fragment = typeof entry.textId === 'string' ? byId.get(entry.textId) : undefined
      if (fragment === undefined || fragment.target !== 'insert') {
        unresolved += 1
        continue
      }
      if (seen.has(entry.name)) throw new Error(`预设里新增段重名：${entry.name}`)
      seen.add(entry.name)
      extras.push({
        id: id('extra'),
        name: entry.name,
        anchor: entry.anchor ?? '__end__',
        order: Number(entry.order) || 0,
        text: fragment.text,
        textId: fragment.id
      })
    }
    for (const entry of preset.transientSections ?? []) {
      const fragment = typeof entry.textId === 'string' ? byId.get(entry.textId) : undefined
      if (fragment === undefined || fragment.target !== 'insert') {
        unresolved += 1
        continue
      }
      if (seen.has(entry.name)) throw new Error(`预设里临时段重名：${entry.name}`)
      seen.add(entry.name)
      transientSections.push({
        id: id('transient'),
        name: entry.name,
        anchor: entry.anchor ?? '__end__',
        order: Number(entry.order) || 0,
        text: fragment.text,
        textId: fragment.id,
        activation: 'once',
        enabled: entry.enabled !== false,
        consumedAtTurn: null,
        updatedAt: Date.now()
      })
    }
    return {
      overrides,
      extras,
      transientSections,
      toolPolicy: {
        allow: null,
        deny: [...new Set((preset.toolPolicy?.deny ?? []).filter((name) => typeof name === 'string'))]
      },
      unresolved
    }
  }

  function sameConfigurationAsPreset (state, preset) {
    const byId = new Map(store.library().fragments.map((fragment) => [fragment.id, fragment]))
    const presetOverrides = {}
    for (const fragmentId of preset?.fragmentIds ?? []) {
      const fragment = byId.get(fragmentId)
      presetOverrides[fragment?.key ?? `__missing:${fragmentId}`] = fragmentId
    }
    const stateExtras = Object.fromEntries((state.extras ?? []).map((entry) => [entry.name, {
      anchor: entry.anchor ?? '__end__',
      order: Number(entry.order) || 0,
      textId: entry.textId ?? null
    }]))
    const presetExtras = Object.fromEntries((preset?.extras ?? []).map((entry) => [entry.name, {
      anchor: entry.anchor ?? '__end__',
      order: Number(entry.order) || 0,
      textId: entry.textId ?? null
    }]))
    const stateTransient = Object.fromEntries((state.transientSections ?? []).map((entry) => [entry.name, {
      anchor: entry.anchor ?? '__end__',
      order: Number(entry.order) || 0,
      activation: 'once',
      enabled: entry.enabled !== false,
      textId: entry.textId ?? null
    }]))
    const presetTransient = Object.fromEntries((preset?.transientSections ?? []).map((entry) => [entry.name, {
      anchor: entry.anchor ?? '__end__',
      order: Number(entry.order) || 0,
      activation: 'once',
      enabled: entry.enabled !== false,
      textId: entry.textId ?? null
    }]))
    const left = JSON.stringify({
      overrides: sortedRecord(state.overrides ?? {}),
      extras: sortedRecord(stateExtras),
      transientSections: sortedRecord(stateTransient),
      toolDeny: [...(state.toolPolicy?.deny ?? [])].sort()
    })
    const right = JSON.stringify({
      overrides: sortedRecord(presetOverrides),
      extras: sortedRecord(presetExtras),
      transientSections: sortedRecord(presetTransient),
      toolDeny: [...(preset?.toolPolicy?.deny ?? [])].sort()
    })
    return left === right
  }

  /**
   * The session's current Prompt Lab preset, independent of whether its saved
   * source still exists. `source` distinguishes a clean preset application
   * (`preset`) from a source that was deleted (`missing`) and from a manually
   * built configuration (`manual`); the prompt page never depends on this
   * object, so a stale reference cannot break it.
   */
  function currentPresetOf (sessionId, state, described) {
    const last = state.lastPreset ?? null
    const preset = last === null ? undefined : store.presets().presets.find((entry) => entry.id === last.id)
    const overrideCount = Object.keys(state.overrides ?? {}).length
    const extraCount = Array.isArray(state.extras) ? state.extras.length : 0
    const transientCount = Array.isArray(state.transientSections) ? state.transientSections.length : 0
    const toolDenyCount = Array.isArray(state.toolPolicy?.deny) ? state.toolPolicy.deny.length : 0
    const hasConfiguration = overrideCount > 0 || extraCount > 0 || transientCount > 0 || toolDenyCount > 0
    const source = last === null ? (hasConfiguration ? 'manual' : 'none') : (preset === undefined ? 'missing' : 'preset')
    return {
      id: last?.id ?? null,
      name: preset?.name ?? last?.name ?? null,
      exists: preset !== undefined,
      source,
      // "No preset and no configuration" is not a modification; it is simply
      // the untouched default state.
      modified: source === 'none' ? false : state.presetModified === true,
      stats: statsOfCurrent(sessionId, state, described),
      overrideCount,
      extraCount,
      transientCount,
      toolDenyCount
    }
  }

  async function presetUsage (presetId) {
    const refs = new Map()
    for (const id of store.listSessionIds()) {
      if (store.state(id).lastPreset?.id === presetId) refs.set(id, false)
    }
    for (const id of store.listDraftIds()) {
      const draft = store.draft(id)
      if (draft?.state?.lastPreset?.id === presetId && !refs.has(id)) refs.set(id, true)
    }
    const ids = [...refs.keys()]
    let livenessMap = new Map()
    try {
      livenessMap = await liveness(ids)
    } catch {
      livenessMap = new Map(ids.map((id) => [id, { id, status: 'unknown', title: null }]))
    }
    const sessions = ids.map((id) => ({
      ...(livenessMap.get(id) ?? { id, status: 'unknown', title: null }),
      id,
      draft: refs.get(id) === true
    }))
    return { count: sessions.length, sessions }
  }

  // preset-editor: Agent preset definitions registered through ctx.agentPresets.
  // The controller is optional so an older/unsupported Host still answers rather
  // than failing the whole panel.
  const agentPresetController = agentPresets ?? null
  const unavailable = () => new Error('当前 DSH 没有 agentPresets 服务，无法注册 Agent 预设')
  const agentPresetState = async () => {
    if (agentPresetController === null) {
      return {
        version: 1,
        supported: false,
        limit: 0,
        reservedIds: [],
        catalog: [],
        fragments: [],
        roster: [],
        failures: [],
        presets: []
      }
    }
    return await agentPresetController.state()
  }
  const agentPresetSave = async (body) => {
    if (agentPresetController === null) throw unavailable()
    const input = body?.preset !== undefined ? body.preset : body
    return await agentPresetController.save(input)
  }
  const agentPresetDelete = async (body) => {
    if (agentPresetController === null) throw unavailable()
    return await agentPresetController.remove(body?.id)
  }

  const handlers = {
    'state.get' (body) {
      return snapshot(sessionOf(body))
    },

    /**
     * Assemble the session's prompt right now, without a user message and
     * without touching the model or the session log. Used by the panel so the
     * official sections are visible before the first turn.
     */
    'assemble.capture': async (body) => {
      const sessionId = sessionOf(body)
      if (typeof captureNow !== 'function') {
        return { ...snapshot(sessionId), capture: { ok: false, reason: 'unavailable' } }
      }
      let result
      try {
        result = await captureNow(sessionId)
      } catch (error) {
        result = { ok: false, reason: String(error?.message ?? error) }
      }
      const value = snapshot(sessionId)
      value.capture = result
      return value
    },

    'tools.list' (body) {
      const sessionId = sessionOf(body)
      return toolsOf(sessionId)
    },

    'assembly.overview' (body) {
      return assemblyOverview(sessionOf(body))
    },

    'agents.read' (body) {
      const sessionId = sessionOf(body)
      return instructions(sessionId)
    },

    async 'messages.appendUser' (body) {
      const sessionId = sessionOf(body)
      const value = text(body.text)
      if (value.trim() === '') throw new Error('message must not be empty')
      const result = await appendUser(sessionId, value)
      if (result?.ok === true) rememberMessageText(value)
      return result
    },

    async 'messages.appendAssistant' (body) {
      const sessionId = sessionOf(body)
      const value = text(body.text)
      if (value.trim() === '') throw new Error('message must not be empty')
      const result = await appendAssistant(sessionId, value)
      if (result?.ok === true) rememberMessageText(value)
      return result
    },

    async 'prefill.send' (body) {
      const sessionId = sessionOf(body)
      const value = text(body.text)
      if (value.trim() === '') throw new Error('message must not be empty')
      const assistantText = typeof body.assistantText === 'string' ? text(body.assistantText) : ''
      if (assistantText !== '' && assistantText.trim() === '') throw new Error('assistant message must not be empty')
      const result = await sendPrefill(sessionId, value, assistantText === '' ? undefined : assistantText)
      if (result?.ok === true) {
        rememberMessageText(value)
        if (assistantText !== '') rememberMessageText(assistantText)
      }
      return result
    },

    'pending.status' (body) {
      const sessionId = sessionOf(body)
      return typeof pendingStatus === 'function'
        ? pendingStatus(sessionId)
        : { pending: false, locked: false, status: null, kind: null, syntheticTurn: null }
    },

    'pending.unlock' (body) {
      const sessionId = sessionOf(body)
      return typeof pendingUnlock === 'function'
        ? pendingUnlock(sessionId)
        : { pending: false, locked: false, status: null, kind: null, syntheticTurn: null }
    },

    'tools.set' (body) {
      const sessionId = sessionOf(body)
      if (!Array.isArray(body.deny)) throw new Error('deny must be an array')
      const deny = [...new Set(body.deny
        .filter((name) => typeof name === 'string')
        .map((name) => name.trim())
        .filter((name) => name !== ''))]
      if (deny.length > 500) throw new Error('too many denied tools')
      ensureDraft(sessionId)
      const value = mutate(sessionId, 'tool policy', (state) => {
        state.toolPolicy = { ...(state.toolPolicy ?? {}), deny }
        if (!Array.isArray(state.toolPolicy.allow)) state.toolPolicy.allow = null
        state.presetModified = true
        return state
      })
      toolPolicyChanged(sessionId)
      return { ...value, tools: toolsOf(sessionId) }
    },

    async 'session.set' (body) {
      const sessionId = sessionOf(body)
      ensureDraft(sessionId)
      const value = mutate(sessionId, 'session settings', (state) => {
        if (typeof body.enabled === 'boolean') state.enabled = body.enabled
        return state
      })
      // First enable of a live session needs a baseline before it can register
      // anything. When no agent is live the saved state is enough: the
      // agent/created hook will install it next time the session opens.
      if (body.enabled === true && typeof agentOf === 'function') {
        const agent = agentOf(sessionId)
        if (agent !== undefined) {
          try {
            await engine.attach(agent)
          } catch {
            /* fail-open: the next capture or agent creation retries */
          }
          toolPolicyChanged(sessionId)
          if (body.enabled === true && typeof lockSession === 'function') {
            try { lockSession(sessionId, 'already-started') } catch { /* best effort */ }
          }
          return snapshot(sessionId)
        }
      }
      toolPolicyChanged(sessionId)
      if (body.enabled === true && typeof lockSession === 'function') {
        try { lockSession(sessionId, 'already-started') } catch { /* best effort */ }
      }
      return value
    },

    'session.reset' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      ensureDraft(sessionId)
      const value = mutate(sessionId, 'reset overrides', (state) => {
        state.overrides = {}
        state.extras = []
        state.transientSections = []
        state.toolPolicy = { allow: null, deny: [] }
        state.structureHash = null
        state.lastPreset = null
        state.presetModified = false
        state.presetStats = null
        return state
      })
      toolPolicyChanged(sessionId)
      notifyTransientChanged(sessionId)
      return value
    },

    /**
     * Save / map / update one section template.
     *
     * Order matters: no-op first (no backup, no updatedAt), then exact
     * key+mode+text dedupe (map only), then update by id or create. Base hashes
     * pin the official text; an explicit rebase re-pins.
     */
    'fragment.save' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      const key = name(body.key)
      if (isReadOnly(key)) {
        throw new Error('该段只读；工具调用由工具开关控制')
      }
      const mode = body.mode === 'empty' ? 'empty' : 'replace'
      const value = text(body.text ?? '')
      const requestedId = typeof body.id === 'string' && body.id !== '' ? text(body.id, 100) : null
      const wantNew = body.new === true
      const explicitLabel = typeof body.label === 'string' && body.label.trim() !== '' ? label(body.label) : null
      let draft = draftOf(sessionId)
      const state = stateOf(sessionId)
      // An override and a user-added section with the same name would collide
      // in engine.sync's desired map (last write wins), leaving one of them
      // silently ineffective. The UI cannot create this, but the API can.
      if ((state.extras ?? []).some((extra) => extra?.name === key) ||
          (state.transientSections ?? []).some((entry) => entry?.name === key)) {
        throw new Error('已有同名新增段或临时段；不能同时作为官方覆盖段')
      }
      const library = libraryOf(sessionId)
      const byId = new Map(library.fragments.map((fragment) => [fragment.id, fragment]))
      const currentId = state.overrides?.[key] ?? null
      const current = currentId === null ? undefined : byId.get(currentId)
      const capture = findCapture(sessionId, key)

      // 1. No change at all. A rebase request is not a no-op: it must move the
      //    template's base hash even when the text is unchanged.
      if (body.rebase !== true &&
          current !== undefined &&
          current.mode === mode &&
          current.text === value &&
          (requestedId === null || requestedId === current.id)) {
        return {
          ...snapshot(sessionId),
          save: { kind: 'unchanged', fragmentId: current.id }
        }
      }

      // 1b. An official section saved with its current official text and no
      //     existing override is also a no-op; it must not create a "default"
      //     template that merely duplicates the official text.
      if (current === undefined && capture !== null) {
        const officialText = typeof capture.officialText === 'string' ? capture.officialText : ''
        const sameAsOfficial = mode === 'empty' ? officialText === '' : value === officialText
        if (body.rebase !== true && sameAsOfficial) {
          return {
            ...snapshot(sessionId),
            save: { kind: 'unchanged', fragmentId: null }
          }
        }
      }

      // 2. The same key+mode+text already exists: map to it, never duplicate.
      const exact = library.fragments.find((fragment) =>
        fragment.target !== 'insert' &&
        fragment.key === key && fragment.mode === mode && fragment.text === value)
      if (exact !== undefined) {
        if (currentId === exact.id) {
          if (body.rebase !== true) {
            return {
              ...snapshot(sessionId),
              save: { kind: 'unchanged', fragmentId: exact.id }
            }
          }
        } else {
          ensureDraft(sessionId)
          draft = draftOf(sessionId)
          backupOf(sessionId, `映射片段 ${key}`, 'auto')
          const next = stateOf(sessionId)
          next.overrides = { ...(next.overrides ?? {}), [key]: exact.id }
          next.presetModified = true
          saveStateOf(sessionId, next)
          engine.sync(sessionId)
          return {
            ...snapshot(sessionId),
            save: { kind: 'mapped', fragmentId: exact.id }
          }
        }
      }

      let target
      if (requestedId !== null) {
        target = byId.get(requestedId)
        if (target === undefined || target.key !== key) throw new Error('片段不存在或段名不匹配')
        if (target.target === 'insert') throw new Error('这是新增段文本，请在文本管理中插入')
      } else if (current !== undefined && wantNew !== true) {
        target = current
      }

      // Template content belongs to the GLOBAL fragment library even when the
      // current window is a draft. Only the mapping in `state.overrides` stays
      // in the draft; a blank window disappearing must not take its template
      // with it.
      ensureDraft(sessionId)
      draft = draftOf(sessionId)

      backupOf(sessionId, `save section ${key}`, 'auto')
      const now = Date.now()
      let fragmentId
      let kind
      if (target !== undefined) {
        const stored = library.fragments.find((fragment) => fragment.id === target.id)
        stored.mode = mode
        stored.target = 'override'
        stored.activation = 'persistent'
        stored.text = value
        stored.updatedAt = now
        if (capture !== null) {
          stored.baseHash = capture.officialHash
          stored.baseText = (capture.officialText ?? '').slice(0, MAX_TEXT)
          delete stored.awaitingBaseline
        } else if (draft !== null || body.rebase === true) {
          // Both a blank-window save and a formal save made while no runtime
          // baseline exists must wait for the first attach to pin. Otherwise
          // `baseHash: null` would be treated as an unconditional override and
          // drift detection would never suspend it.
          stored.awaitingBaseline = true
        }
        fragmentId = stored.id
        kind = 'updated'
      } else {
        fragmentId = id('frag')
        const fragment = {
          id: fragmentId,
          key,
          label: explicitLabel ?? nextDefaultLabel(library.fragments),
          mode,
          target: 'override',
          activation: 'persistent',
          text: value,
          baseHash: capture?.officialHash ?? null,
          baseText: (capture?.officialText ?? '').slice(0, MAX_TEXT),
          createdAt: now,
          updatedAt: now
        }
        if (capture === null) fragment.awaitingBaseline = true
        library.fragments.push(fragment)
        kind = 'created'
      }
      saveLibraryOf(sessionId, library)
      const next = stateOf(sessionId)
      next.overrides = { ...(next.overrides ?? {}), [key]: fragmentId }
      next.presetModified = true
      saveStateOf(sessionId, next)
      // The template is in the global library and may be mapped by other live
      // sessions; reconcile all of them, not only the one that saved.
      engine.syncAll()
      return {
        ...snapshot(sessionId),
        save: { kind, fragmentId }
      }
    },

    /**
     * Re-pin one template to the current official text. Accepts the new
     * `{ id }` form and the old `{ key }` form while the UI is migrated.
     */
    'fragment.rebase' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      const library = clone(store.libraryFor(sessionId))
      const state = clone(store.stateFor(sessionId))
      let fragment
      if (typeof body.id === 'string' && body.id !== '') {
        fragment = library.fragments.find((entry) => entry.id === text(body.id, 100))
      } else {
        const key = name(body.key)
        const currentId = state.overrides?.[key]
        fragment = currentId === undefined
          ? library.fragments.find((entry) => entry.key === key)
          : library.fragments.find((entry) => entry.id === currentId)
      }
      if (fragment === undefined) throw new Error('fragment not found')
      const capture = findCapture(sessionId, fragment.key)
      if (capture === null) throw new Error('no captured section with that name')
      backupOf(sessionId, `rebase ${fragment.key}`, 'auto')
      fragment.baseHash = capture.officialHash
      fragment.baseText = (capture.officialText ?? '').slice(0, MAX_TEXT)
      fragment.updatedAt = Date.now()
      delete fragment.awaitingBaseline
      saveLibraryOf(sessionId, library)
      engine.syncAll()
      return snapshot(sessionId)
    },

    'fragment.rename' (body) {
      const sessionId = sessionOf(body)
      const fragmentId = text(body.id, 100)
      const nextLabel = label(body.label, '默认')
      const draft = draftOf(sessionId)
      const draftFragment = draft !== null && draft.fragments.some((entry) => entry.id === fragmentId)
      const library = clone(draftFragment ? store.libraryFor(sessionId) : store.library())
      const fragment = library.fragments.find((entry) => entry.id === fragmentId)
      if (fragment === undefined) throw new Error('片段不存在')
      if (isReadOnly(fragment.key)) throw new Error('工具/能力协议段只读，不能重命名')
      fragment.label = nextLabel
      if (draftFragment) saveLibraryOf(sessionId, library)
      else store.saveLibrary(library)
      return snapshot(sessionId)
    },

    'override.clear' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      const key = name(body.key)
      ensureDraft(sessionId)
      return mutate(sessionId, `clear ${key}`, (state) => {
        delete state.overrides[key]
        state.presetModified = true
        return state
      })
    },

    /**
     * Delete one fragment. A fragment still referenced by another session or by
     * a preset needs an explicit `cascade: true`, so a library-page deletion
     * cannot silently unhook other sessions. Every affected session gets its
     * own backup before the state is rewritten.
     */
    async 'fragment.delete' (body) {
      const sessionId = sessionOf(body)
      const fragmentId = text(body.id, 100)
      const currentDraft = draftOf(sessionId)
      if (currentDraft !== null && currentDraft.fragments.some((entry) => entry.id === fragmentId)) {
        // Draft-private template: deleting it only affects this window.
        const next = {
          ...currentDraft,
          fragments: currentDraft.fragments.filter((entry) => entry.id !== fragmentId)
        }
        for (const [key, value] of Object.entries(next.state.overrides ?? {})) {
          if (value === fragmentId) {
            delete next.state.overrides[key]
            next.state.presetModified = true
          }
        }
        next.state.extras = (next.state.extras ?? []).filter((extra) => extra?.textId !== fragmentId)
        next.state.transientSections = (next.state.transientSections ?? [])
          .filter((transient) => transient?.textId !== fragmentId)
        store.saveDraft(sessionId, next)
        engine.sync(sessionId)
        return {
          ...snapshot(sessionId),
          deleted: { sessions: [], presets: [], skipped: [], draft: true }
        }
      }
      const fragment = store.library().fragments.find((entry) => entry.id === fragmentId)
      if (fragment === undefined) throw new Error('片段不存在')

      // Collect every reference shape: official override, extra textId,
      // transient textId, and blank-window draft references.
      const refs = new Map()
      const collect = (id, state, draft) => {
        let hit = Object.values(state.overrides ?? {}).includes(fragmentId)
        if (!hit) hit = (state.extras ?? []).some((extra) => extra?.textId === fragmentId)
        if (!hit) hit = (state.transientSections ?? []).some((transient) => transient?.textId === fragmentId)
        if (!hit) return
        if (!refs.has(id) || refs.get(id) !== false) refs.set(id, draft === true)
      }
      for (const id of store.listSessionIds()) collect(id, store.state(id), false)
      for (const id of store.listDraftIds()) {
        const draft = store.draft(id)
        if (draft !== null) collect(id, draft.state, true)
      }
      const affectedIds = [...refs.keys()]
      let livenessMap = new Map()
      try {
        livenessMap = await liveness(affectedIds)
      } catch {
        livenessMap = new Map(affectedIds.map((id) => [id, { id, status: 'unknown', title: null }]))
      }
      const affected = affectedIds.map((id) => ({
        ...(livenessMap.get(id) ?? { id, status: 'unknown', title: null }),
        id,
        draft: refs.get(id) === true,
        locked: promptLocked(id)
      }))
      const persistent = affected.filter((entry) => ['live', 'saved', 'archived'].includes(entry.status))
      const otherPersistent = persistent.filter((entry) => entry.id !== sessionId && entry.locked !== true)
      const otherDrafts = affected.filter((entry) => entry.draft === true && entry.id !== sessionId)
      const presetReferences = (preset) =>
        (Array.isArray(preset.fragmentIds) && preset.fragmentIds.includes(fragmentId)) ||
        (preset.extras ?? []).some((entry) => entry?.textId === fragmentId) ||
        (preset.transientSections ?? []).some((entry) => entry?.textId === fragmentId)
      const affectedPresets = store.presets().presets.filter(presetReferences)

      if (body.cascade !== true &&
          (otherPersistent.length > 0 || otherDrafts.length > 0 || affectedPresets.length > 0)) {
        throw new Error('该片段仍被引用，删除需要 cascade: true')
      }

      // Back up only sessions whose DSH session still exists. Backing up a
      // missing session would recreate its plugin directory as a ghost. Draft
      // windows have no formal state, so they are never backed up here.
      for (const entry of persistent) {
        if (entry.draft === true || entry.locked === true) continue
        store.backup(entry.id, `删除片段 ${fragment.key}`, 'auto')
      }

      const library = clone(store.library())
      library.fragments = library.fragments.filter((entry) => entry.id !== fragmentId)
      store.saveLibrary(library)

      const skipped = []
      for (const entry of affected) {
        if (entry.locked) continue
        if (entry.draft) {
          const draft = store.draft(entry.id)
          if (draft === null) continue
          const state = draft.state
          for (const [key, value] of Object.entries(state.overrides ?? {})) {
            if (value === fragmentId) delete state.overrides[key]
          }
          state.extras = (state.extras ?? []).filter((extra) => extra?.textId !== fragmentId)
          state.transientSections = (state.transientSections ?? [])
            .filter((transient) => transient?.textId !== fragmentId)
          state.presetModified = true
          store.saveDraft(entry.id, draft)
          if (entry.id === sessionId) engine.sync(entry.id)
          continue
        }
        // `unknown` is never proof of absence: do not rewrite its state.
        if (entry.status === 'unknown') {
          skipped.push(entry.id)
          continue
        }
        const state = clone(store.state(entry.id))
        for (const [key, value] of Object.entries(state.overrides ?? {})) {
          if (value === fragmentId) delete state.overrides[key]
        }
        state.extras = (state.extras ?? []).filter((extra) => extra?.textId !== fragmentId)
        state.transientSections = (state.transientSections ?? [])
          .filter((transient) => transient?.textId !== fragmentId)
        state.presetModified = true
        store.saveState(entry.id, state)
        engine.sync(entry.id)
      }

      if (affectedPresets.length > 0) {
        const value = clone(store.presets())
        const now = Date.now()
        for (const preset of value.presets) {
          let touched = false
          if (Array.isArray(preset.fragmentIds) && preset.fragmentIds.includes(fragmentId)) {
            preset.fragmentIds = preset.fragmentIds.filter((entry) => entry !== fragmentId)
            touched = true
          }
          if (Array.isArray(preset.extras)) {
            const next = preset.extras.filter((entry) => entry?.textId !== fragmentId)
            if (next.length !== preset.extras.length) {
              preset.extras = next
              touched = true
            }
          }
          if (Array.isArray(preset.transientSections)) {
            const next = preset.transientSections.filter((entry) => entry?.textId !== fragmentId)
            if (next.length !== preset.transientSections.length) {
              preset.transientSections = next
              touched = true
            }
          }
          if (touched) preset.updatedAt = now
        }
        store.savePresets(value)
      }

      return {
        ...snapshot(sessionId),
        deleted: {
          sessions: affected,
          presets: affectedPresets.map((preset) => preset.name),
          skipped,
          draftReferenced: currentDraft !== null && refs.get(sessionId) === true
        }
      }
    },

    /**
     * P6 section text library. `create`/`update` only touch the global library;
     * `insert` creates a session section that references one entry.
     */
    'sectionText.create' (body) {
      const sessionId = sessionOf(body)
      const key = name(body.key ?? body.name)
      if (isReadOnly(key)) throw new Error('工具/能力协议段只读')
      if (sectionSource(key) === 'official') throw new Error('官方段请在提示词页保存模板')
      const value = text(body.text ?? '')
      if (value.trim() === '') throw new Error('段文本不能为空')
      const library = clone(store.library())
      const exact = library.fragments.find((fragment) =>
        fragment.target === 'insert' &&
        fragment.key === key &&
        fragment.mode === 'replace' &&
        fragment.text === value)
      if (exact !== undefined) {
        return { ...snapshot(sessionId), text: { kind: 'mapped', entry: sectionEntryView(exact) } }
      }
      const now = Date.now()
      const entry = {
        id: id('frag'),
        key,
        label: typeof body.label === 'string' && body.label.trim() !== ''
          ? label(body.label)
          : nextDefaultLabel(library.fragments),
        mode: 'replace',
        target: 'insert',
        activation: 'persistent',
        text: value,
        baseHash: null,
        baseText: '',
        createdAt: now,
        updatedAt: now
      }
      library.fragments.push(entry)
      store.saveLibrary(library)
      engine.sync(sessionId)
      return { ...snapshot(sessionId), text: { kind: 'created', entry: sectionEntryView(entry) } }
    },

    'sectionText.get' (body) {
      const entryId = text(body.id, 100)
      const entry = store.library().fragments.find((fragment) => fragment.id === entryId)
      if (entry === undefined) throw new Error('段文本不存在')
      return sectionEntryView(entry)
    },

    'sectionText.update' (body) {
      const sessionId = sessionOf(body)
      const entryId = text(body.id, 100)
      const library = clone(store.library())
      const entry = library.fragments.find((fragment) => fragment.id === entryId)
      if (entry === undefined) throw new Error('段文本不存在')
      const lockedSnapshot = store.lockedSnapshot(sessionId)
      if (promptLocked(sessionId) && (lockedSnapshot === null || lockedSnapshot.sections.some((section) => section.textId === entryId))) {
        throw new Error('该文本被当前已锁定会话引用，不能编辑；请新建会话后再修改')
      }
      if (entry.target !== 'insert') throw new Error('官方段模板请在提示词页编辑')
      if (isReadOnly(entry.key)) throw new Error('工具/能力协议段只读')
      if (typeof body.text === 'string') {
        if (body.text.trim() === '') throw new Error('段文本不能为空')
        entry.text = text(body.text)
      }
      if (typeof body.label === 'string') entry.label = label(body.label)
      if (body.activation !== undefined) entry.activation = 'persistent'
      entry.updatedAt = Date.now()
      store.saveLibrary(library)
      // This entry can be referenced by extras/transients in many live sessions.
      engine.syncAll()
      return { ...snapshot(sessionId), text: { kind: 'updated', entry: sectionEntryView(entry) } }
    },

    'sectionText.insert' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      const entryId = text(body.id, 100)
      const entry = store.library().fragments.find((fragment) => fragment.id === entryId)
      if (entry === undefined) throw new Error('段文本不存在')
      if (entry.target !== 'insert' || entry.mode !== 'replace') throw new Error('这条文本不能作为新增段插入')
      const insertName = name(body.name === undefined ? entry.key : body.name)
      if (isReadOnly(insertName)) throw new Error('工具/能力协议段只读，不能作为新增段')
      if (sectionSource(insertName) === 'official') throw new Error('已有同名官方段，不能作为新增段')
      const described = engine.describe(sessionId)
      if ((described.officialNames ?? []).includes(insertName)) {
        throw new Error('已有同名官方段，不能作为新增段')
      }
      const before = stateOf(sessionId)
      if ((before.overrides ?? {})[insertName] !== undefined) {
        throw new Error('已有同名覆盖段，不能作为新增段')
      }
      if ((before.extras ?? []).some((extra) => extra.name === insertName) ||
          (before.transientSections ?? []).some((transient) => transient.name === insertName)) {
        throw new Error('已有同名的新增段或临时段')
      }
      const activation = 'persistent'
      const anchor = typeof body.anchor === 'string' && body.anchor !== '' ? text(body.anchor, 200) : '__end__'
      ensureDraft(sessionId)
      let transientId = null
      const next = mutate(sessionId, `insert ${entry.key}`, (state) => {
        const extras = Array.isArray(state.extras) ? state.extras : []
        const transient = Array.isArray(state.transientSections) ? state.transientSections : []
        const maxOrder = [...extras, ...transient].reduce((max, item) => Math.max(max, Number(item.order) || 0), 0)
        if (activation === 'persistent') {
          extras.push({
            id: id('extra'),
            name: insertName,
            anchor,
            order: maxOrder + 10,
            text: entry.text,
            textId: entry.id
          })
          state.extras = extras
        } else {
          transientId = id('transient')
          transient.push({
            id: transientId,
            name: insertName,
            anchor,
            order: maxOrder + 10,
            text: entry.text,
            textId: entry.id,
            activation,
            enabled: true,
            consumedAtTurn: null,
            updatedAt: Date.now()
          })
          state.transientSections = transient
        }
        state.presetModified = true
        return state
      })
      if (transientId !== null) notifyTransientChanged(sessionId, transientId)
      return {
        ...next,
        insert: { kind: activation === 'persistent' ? 'extra' : 'transient', name: insertName, textId: entry.id }
      }
    },

    async 'messages.text.list' (body) {
      const sessionId = sessionOf(body)
      const entries = store.messageLibrary().entries.map((entry) => ({
        ...entry,
        tokens: estimateTokens(entry.text),
        preview: entry.text.slice(0, 400)
      }))
      return {
        entries,
        limits: { entries: MESSAGE_ENTRY_LIMIT, text: MESSAGE_TEXT_LIMIT },
        sessionId
      }
    },

    'messages.text.save' (body) {
      const sessionId = sessionOf(body)
      const entryId = typeof body.id === 'string' && body.id !== '' ? text(body.id, 100) : null
      const value = text(body.text ?? '', MESSAGE_TEXT_LIMIT)
      if (value.trim() === '') throw new Error('消息文本不能为空')
      const library = clone(store.messageLibrary())
      const now = Date.now()
      if (entryId !== null) {
        const entry = library.entries.find((item) => item.id === entryId)
        if (entry === undefined) throw new Error('消息文本不存在')
        entry.text = value
        entry.updatedAt = now
        if (typeof body.label === 'string' && body.label.trim() !== '') entry.label = label(body.label)
        store.saveMessageLibrary(library)
        return { ...snapshot(sessionId), text: { kind: 'updated', id: entry.id } }
      }
      const exact = library.entries.find((entry) => entry.text === value)
      if (exact !== undefined) {
        if (typeof body.label === 'string' && body.label.trim() !== '') {
          exact.label = label(body.label)
          exact.updatedAt = now
          store.saveMessageLibrary(library)
        }
        return { ...snapshot(sessionId), text: { kind: 'mapped', id: exact.id } }
      }
      if (library.entries.length >= MESSAGE_ENTRY_LIMIT) {
        throw new Error(`消息文本数量已达上限（${MESSAGE_ENTRY_LIMIT}）`)
      }
      const entry = {
        id: id('msg'),
        label: typeof body.label === 'string' && body.label.trim() !== ''
          ? label(body.label)
          : nextDefaultLabel(library.entries),
        text: value,
        createdAt: now,
        updatedAt: now
      }
      library.entries.push(entry)
      store.saveMessageLibrary(library)
      return { ...snapshot(sessionId), text: { kind: 'created', id: entry.id } }
    },

    async 'messages.text.delete' (body) {
      const sessionId = sessionOf(body)
      const entryId = text(body.id, 100)
      const entry = store.messageLibrary().entries.find((item) => item.id === entryId)
      if (entry === undefined) throw new Error('消息文本不存在')
      const library = clone(store.messageLibrary())
      library.entries = library.entries.filter((item) => item.id !== entryId)
      store.saveMessageLibrary(library)
      return { ...snapshot(sessionId), deleted: { id: entryId } }
    },

    /**
     * The fragment library's own view: every saved fragment with its cross-
     * session and preset references. `orphan` is relative to the current
     * session's captured assembly; `null` means "not captured here, unknown".
     */
    // preset-editor: Agent preset roster and definitions (global, not per session).
    async 'agentPresets.state' () {
      return await agentPresetState()
    },
    async 'agentPresets.save' (body) {
      return await agentPresetSave(body)
    },
    async 'agentPresets.delete' (body) {
      return await agentPresetDelete(body)
    },
    async 'agentPresets.copy' (body) {
      if (agentPresetController === null) throw unavailable()
      return await agentPresetController.copy(body?.id)
    },

    async 'library.list' (body) {
      const sessionId = sessionOf(body)
      const described = engine.describe(sessionId)
      const library = store.library()

      // One entry can be referenced by an official override, by an extra, or by
      // a transient. Drafts are global text references too, so include them.
      const refIndex = new Map()
      const addRef = (fragmentId, id, draft) => {
        if (typeof fragmentId !== 'string' || fragmentId === '') return
        const list = refIndex.get(fragmentId) ?? new Map()
        if (!list.has(id) || list.get(id) !== false) list.set(id, draft === true)
        refIndex.set(fragmentId, list)
      }
      for (const id of store.listSessionIds()) {
        const state = store.state(id)
        for (const fragmentId of Object.values(state.overrides ?? {})) addRef(fragmentId, id, false)
        for (const extra of state.extras ?? []) addRef(extra?.textId, id, false)
        for (const transient of state.transientSections ?? []) addRef(transient?.textId, id, false)
      }
      for (const id of store.listDraftIds()) {
        const draft = store.draft(id)
        if (draft === null) continue
        for (const fragmentId of Object.values(draft.state.overrides ?? {})) addRef(fragmentId, id, true)
        for (const extra of draft.state.extras ?? []) addRef(extra?.textId, id, true)
        for (const transient of draft.state.transientSections ?? []) addRef(transient?.textId, id, true)
      }

      const presetIndex = new Map()
      const addPresetRef = (fragmentId, presetName) => {
        if (typeof fragmentId !== 'string' || fragmentId === '') return
        const list = presetIndex.get(fragmentId) ?? []
        if (!list.includes(presetName)) list.push(presetName)
        presetIndex.set(fragmentId, list)
      }
      for (const preset of store.presets().presets) {
        for (const fragmentId of preset.fragmentIds ?? []) addPresetRef(fragmentId, preset.name)
        // An insert text entry is referenced from a preset extra/transient,
        // not from `fragmentIds`; it must still show its preset usage.
        for (const entry of preset.extras ?? []) addPresetRef(entry?.textId, preset.name)
        for (const entry of preset.transientSections ?? []) addPresetRef(entry?.textId, preset.name)
      }

      const usageIds = [...new Set([...refIndex.values()].flatMap((map) => [...map.keys()]))]
      let livenessMap = new Map()
      try {
        livenessMap = await liveness(usageIds)
      } catch {
        livenessMap = new Map(usageIds.map((id) => [id, { id, status: 'unknown', title: null }]))
      }
      const officialKnown = described.captured === true
      const officialNames = new Set(described.officialNames ?? [])
      const completeActive = described.completeActive === true

      const sessionUsage = (fragmentId) => {
        const refs = refIndex.get(fragmentId) ?? new Map()
        const sessions = []
        const drafts = []
        for (const [id, draft] of refs.entries()) {
          const view = {
            ...(livenessMap.get(id) ?? { id, status: 'unknown', title: null }),
            id,
            draft
          }
          if (draft) drafts.push(view)
          else sessions.push(view)
        }
        return { sessions, drafts }
      }

      const fragments = library.fragments.map((fragment) => {
        const target = fragment.target === 'insert' ? 'insert' : 'override'
        const usage = sessionUsage(fragment.id)
        return {
          id: fragment.id,
          key: fragment.key,
          label: fragment.label ?? '',
          mode: fragment.mode === 'empty' ? 'empty' : 'replace',
          target,
          activation: activationOf(fragment.activation),
          insertable: target === 'insert' && fragment.mode !== 'empty',
          tokens: estimateTokens(fragment.text ?? ''),
          updatedAt: fragment.updatedAt ?? 0,
          createdAt: fragment.createdAt ?? 0,
          preview: String(fragment.text ?? '').slice(0, 400),
          source: fragmentSource(fragment.key),
          sensitivity: sensitivityOf(fragment.key),
          readOnly: isReadOnlySection(fragment.key),
          usage: {
            sessions: usage.sessions,
            drafts: usage.drafts,
            presets: presetIndex.get(fragment.id) ?? []
          },
          // A complete preset drops every section, so "not in the official
          // baseline" is not the same as "removed from the Harness". Report it
          // as blocked in this session, never as a red orphan. Insert entries
          // are intentional custom names and can never be orphaned this way.
          orphan: target === 'insert'
            ? false
            : completeActive ? null : officialKnown ? !officialNames.has(fragment.key) : null,
          blocked: completeActive
        }
      })

      const groups = []
      const groupByKey = new Map()
      for (const fragment of fragments) {
        let group = groupByKey.get(fragment.key)
        if (group === undefined) {
          group = {
            key: fragment.key,
            source: fragmentSource(fragment.key),
            sensitivity: sensitivityOf(fragment.key),
            readOnly: isReadOnlySection(fragment.key),
            target: fragment.target,
            activation: fragment.activation,
            templateCount: 0,
            orphan: false,
            blocked: completeActive,
            usage: { sessions: 0, presets: 0, drafts: 0 },
            _sessionIds: new Set(),
            _draftIds: new Set(),
            _presets: new Set(),
            _allOverride: true,
            templates: []
          }
          groupByKey.set(fragment.key, group)
          groups.push(group)
        }
        if (fragment.target !== 'insert') group._allOverride = false
        group.templateCount += 1
        group.templates.push(fragment)
        for (const session of fragment.usage.sessions) group._sessionIds.add(session.id)
        for (const draft of fragment.usage.drafts ?? []) group._draftIds.add(draft.id)
        for (const preset of fragment.usage.presets) group._presets.add(preset)
      }
      for (const group of groups) {
        group.usage = {
          sessions: group._sessionIds.size,
          presets: group._presets.size,
          drafts: group._draftIds.size
        }
        group.target = group._allOverride ? 'override' : 'insert'
        group.orphan = group.target === 'insert'
          ? false
          : completeActive ? null : officialKnown ? !officialNames.has(group.key) : null
        delete group._sessionIds
        delete group._draftIds
        delete group._presets
        delete group._allOverride
      }
      const officialOrder = new Map((described.officialNames ?? []).map((name, index) => [name, index]))
      groups.sort((a, b) => {
        const left = officialOrder.has(a.key) ? officialOrder.get(a.key) : null
        const right = officialOrder.has(b.key) ? officialOrder.get(b.key) : null
        if (left !== null && right !== null) return left - right
        if (left !== null) return -1
        if (right !== null) return 1
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
      })

      return {
        officialKnown,
        completeActive,
        fragments,
        groups,
        messageEntries: store.messageLibrary().entries.length
      }
    },

    /**
     * Save one user section. `anchor` is an official section name, `__start__`
     * or `__end__`; extras sharing an anchor keep their explicit `order`.
     */
    'extra.save' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      const extraName = name(body.name)
      if (isReadOnly(extraName)) throw new Error('工具/能力协议段只读，不能作为新增段')
      assertInsertNameAvailable(sessionId, extraName)
      const value = text(body.text ?? '')
      const anchor = typeof body.anchor === 'string' && body.anchor !== '' ? text(body.anchor, 200) : '__end__'
      if (value.trim() === '') throw new Error('新增段正文不能为空')
      const before = stateOf(sessionId)
      if ((before.transientSections ?? []).some((entry) => entry.name === extraName)) {
        throw new Error('已有同名的临时段')
      }
      const current = (before.extras ?? []).find((entry) => entry.name === extraName)
      const resolved = ensureInsertText(extraName, value, 'persistent', current?.textId)
      ensureDraft(sessionId)
      return mutate(sessionId, `save section ${extraName}`, (state) => {
        const extras = Array.isArray(state.extras) ? state.extras : []
        const existing = extras.find((extra) => extra.name === extraName)
        if (existing !== undefined) {
          existing.text = value
          existing.textId = resolved.textId
          existing.anchor = anchor
          if (typeof body.order === 'number') existing.order = body.order
        } else {
          const maxOrder = extras.reduce((max, extra) => Math.max(max, Number(extra.order) || 0), 0)
          extras.push({
            id: id('extra'),
            name: extraName,
            anchor,
            order: typeof body.order === 'number' ? body.order : maxOrder + 10,
            text: value,
            textId: resolved.textId
          })
          state.extras = extras
        }
        state.presetModified = true
        return state
      })
    },

    'transient.save' (body) {
      const sessionId = sessionOf(body)
      throw new Error('1.1.0 已移除临时段；请使用常驻段或新建会话配置')
      assertPromptEditable(sessionId)
      const transientName = name(body.name)
      if (isReadOnly(transientName)) throw new Error('工具/能力协议段只读，不能作为临时段')
      assertInsertNameAvailable(sessionId, transientName)
      const value = text(body.text ?? '')
      const anchor = typeof body.anchor === 'string' && body.anchor !== '' ? text(body.anchor, 200) : '__end__'
      if (value.trim() === '') throw new Error('临时段正文不能为空')
      const activation = 'once'
      const before = stateOf(sessionId)
      const transientId = typeof body.id === 'string' ? body.id : ''
      const existingBefore = (before.transientSections ?? [])
        .find((entry) => entry.id === transientId || entry.name === transientName)
      const duplicateExtra = (before.extras ?? []).some((entry) => entry.name === transientName)
      const duplicateTransient = (before.transientSections ?? [])
        .some((entry) => entry.name === transientName && entry.id !== existingBefore?.id)
      if (duplicateExtra || duplicateTransient) throw new Error('已有同名的新增段或临时段')
      const resolved = ensureInsertText(transientName, value, activation, existingBefore?.textId)
      ensureDraft(sessionId)
      const valueSnapshot = mutate(sessionId, `save transient ${transientName}`, (state) => {
        const transient = Array.isArray(state.transientSections) ? state.transientSections : []
        const extras = Array.isArray(state.extras) ? state.extras : []
        const targetId = typeof body.id === 'string' ? body.id : ''
        const existing = transient.find((entry) => entry.id === targetId || entry.name === transientName)
        if (existing !== undefined) {
          existing.name = transientName
          existing.text = value
          existing.textId = resolved.textId
          existing.anchor = anchor
          existing.activation = activation
          existing.enabled = body.enabled !== false
          existing.consumedAtTurn = null
          existing.updatedAt = Date.now()
          if (typeof body.order === 'number') existing.order = body.order
        } else {
          const maxOrder = [...extras, ...transient].reduce((max, entry) => Math.max(max, Number(entry.order) || 0), 0)
          transient.push({
            id: id('transient'),
            name: transientName,
            anchor,
            order: typeof body.order === 'number' ? body.order : maxOrder + 10,
            text: value,
            textId: resolved.textId,
            activation,
            enabled: body.enabled !== false,
            consumedAtTurn: null,
            updatedAt: Date.now()
          })
          state.transientSections = transient
        }
        state.presetModified = true
        return state
      })
      notifyTransientChanged(sessionId, body.id)
      return valueSnapshot
    },

    'transient.toggle' (body) {
      const sessionId = sessionOf(body)
      throw new Error('1.1.0 已移除临时段；请使用常驻段或新建会话配置')
      assertPromptEditable(sessionId)
      const transientId = text(body.id, 100)
      ensureDraft(sessionId)
      const value = mutate(sessionId, 'toggle transient', (state) => {
        const entry = (Array.isArray(state.transientSections) ? state.transientSections : [])
          .find((item) => item.id === transientId)
        if (entry === undefined) throw new Error('transient not found')
        entry.enabled = body.enabled === true
        entry.updatedAt = Date.now()
        state.presetModified = true
        return state
      })
      notifyTransientChanged(sessionId, transientId)
      return value
    },

    'transient.delete' (body) {
      const sessionId = sessionOf(body)
      throw new Error('1.1.0 已移除临时段；请使用常驻段或新建会话配置')
      assertPromptEditable(sessionId)
      const transientId = text(body.id, 100)
      ensureDraft(sessionId)
      const value = mutate(sessionId, 'delete transient', (state) => {
        state.transientSections = (state.transientSections ?? []).filter((entry) => entry.id !== transientId)
        state.presetModified = true
        return state
      })
      notifyTransientChanged(sessionId, transientId)
      return value
    },

    /**
     * Move one user section one visible row up or down in the assembled order.
     * Crossing an official section re-anchors the section, so the panel order
     * and the prompt order stay the same thing. At an edge this is a silent
     * no-op: the caller logs nothing and writes no backup.
     */
    'extra.move' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      const extraId = text(body.id, 100)
      const delta = Number(body.delta) === -1 ? -1 : 1
      const rows = engine.describe(sessionId).sections
      const index = rows.findIndex((row) => row.extraId === extraId)
      if (index < 0) throw new Error('section not found')
      const neighbour = rows[index + delta]
      if (neighbour === undefined) return snapshot(sessionId)
      ensureDraft(sessionId)

      return mutate(sessionId, 'reorder section', (state) => {
        const extras = Array.isArray(state.extras) ? state.extras : []
        const target = extras.find((extra) => extra.id === extraId)
        if (target === undefined) throw new Error('section not found')
        state.presetModified = true
        const anchorOf = (extra) => (typeof extra.anchor === 'string' && extra.anchor !== '' ? extra.anchor : '__end__')
        const orderOf = (extra) => Number(extra.order) || 0
        const others = extras.filter((extra) => extra.id !== extraId)

        if (neighbour.status === 'extra') {
          const other = extras.find((extra) => extra.id === neighbour.extraId)
          if (other === undefined) return state
          const targetAnchor = anchorOf(target)
          const targetOrder = orderOf(target)
          const otherAnchor = anchorOf(other)
          const otherOrder = orderOf(other)
          target.anchor = otherAnchor
          target.order = otherOrder
          other.anchor = targetAnchor
          other.order = otherOrder === targetOrder ? otherOrder + delta : targetOrder
          return state
        }

        if (delta > 0) {
          // Land immediately after the official section we just crossed.
          const sameAnchor = others.filter((extra) => anchorOf(extra) === neighbour.name)
          target.anchor = neighbour.name
          target.order = sameAnchor.length === 0 ? 0 : Math.min(...sameAnchor.map(orderOf)) - 10
          return state
        }

        // Moving up past an official section: land immediately before it, which
        // means anchoring to the official section that precedes it.
        const j = index + delta
        const before = [...rows.slice(0, j)].reverse().find((row) => row.status !== 'extra')
        const anchor = before === undefined ? '__start__' : before.name
        const sameAnchor = others.filter((extra) => anchorOf(extra) === anchor)
        target.anchor = anchor
        target.order = sameAnchor.length === 0 ? 0 : Math.max(...sameAnchor.map(orderOf)) + 10
        return state
      })
    },

    'extra.delete' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      const extraId = text(body.id, 100)
      ensureDraft(sessionId)
      return mutate(sessionId, 'delete section', (state) => {
        state.extras = (state.extras ?? []).filter((extra) => extra.id !== extraId)
        state.presetModified = true
        return state
      })
    },

    'preset.save' (body) {
      const sessionId = sessionOf(body)
      const preset = body.preset ?? {}
      const presetName = name(preset.name ?? 'preset')
      const byId = new Map(store.library().fragments.map((fragment) => [fragment.id, fragment]))
      const fragmentIds = Array.isArray(preset.fragmentIds)
        ? preset.fragmentIds
          .filter((entry) => typeof entry === 'string' && byId.has(entry))
          .filter((fragmentId) => byId.get(fragmentId)?.target !== 'insert')
          .filter((fragmentId) => !isReadOnly(byId.get(fragmentId)?.key))
        : null
      const extras = presetExtrasInput(preset.extras)
      const transientSections = presetTransientInput(preset.transientSections)
      if (fragmentIds !== null) presetMapping(fragmentIds, sessionId)
      const value = clone(store.presets())
      const existing = value.presets.find((entry) => entry.id === preset.id)
      if (existing === undefined && value.presets.length >= (settingsOf().presetLimit ?? 10)) {
        throw new Error(`预设数量已达上限（${settingsOf().presetLimit}），请先在设置里调高或删掉旧预设`)
      }
      backupOf(sessionId, `save preset ${presetName}`, 'auto')
      const now = Date.now()
      if (existing === undefined) {
        value.presets.push({
          version: 3,
          id: id('preset'),
          name: presetName,
          note: typeof preset.note === 'string' ? text(preset.note, 2000) : '',
          fragmentIds: fragmentIds ?? [],
          extras: extras ?? [],
          transientSections: transientSections ?? [],
          toolPolicy: {
            allow: null,
            deny: [...new Set((preset.toolPolicy?.deny ?? []).filter((name) => typeof name === 'string'))]
          },
          updatedAt: now
        })
      } else {
        existing.name = presetName
        existing.note = typeof preset.note === 'string' ? text(preset.note, 2000) : existing.note
        if (fragmentIds !== null) existing.fragmentIds = fragmentIds
        if (extras !== null) existing.extras = extras
        if (transientSections !== null) existing.transientSections = transientSections
        if (preset.toolPolicy !== undefined) {
          existing.toolPolicy = {
            allow: null,
            deny: [...new Set((preset.toolPolicy?.deny ?? []).filter((name) => typeof name === 'string'))]
          }
        }
        existing.version = 3
        existing.updatedAt = now
      }
      store.savePresets(value)

      const state = stateOf(sessionId)
      if (state.lastPreset?.id !== undefined && state.lastPreset.id === preset.id) {
        state.lastPreset = { ...state.lastPreset, name: presetName }
        state.presetModified = !sameConfigurationAsPreset(state, store.presets().presets.find((entry) => entry.id === preset.id))
        saveStateOf(sessionId, state)
      }
      return snapshot(sessionId)
    },

    'preset.capture' (body) {
      const sessionId = sessionOf(body)
      const presetName = name(body.name ?? 'preset')
      const value = clone(store.presets())
      const limit = settingsOf().presetLimit ?? DEFAULT_CONFIG.presetLimit
      if (value.presets.length >= limit) {
        throw new Error(`预设数量已达上限（${limit}），请先在设置里调高或删掉旧预设`)
      }
      ensureDraft(sessionId)
      backupOf(sessionId, `capture preset ${presetName}`, 'auto')
      const state = stateOf(sessionId)
      const library = store.library()
      const globalIds = new Set(library.fragments.map((fragment) => fragment.id))
      const presetId = id('preset')
      value.presets.push({
        version: 3,
        id: presetId,
        name: presetName,
        note: typeof body.note === 'string' ? text(body.note, 2000) : '',
        fragmentIds: Object.entries(state.overrides ?? {})
          .filter(([key]) => !isReadOnly(key))
          .map(([, fragmentId]) => fragmentId)
          .filter((fragmentId) => globalIds.has(fragmentId))
          .filter((fragmentId) => library.fragments.find((fragment) => fragment.id === fragmentId)?.target !== 'insert'),
        extras: (state.extras ?? []).map((entry) => ({
          name: entry.name,
          anchor: entry.anchor ?? '__end__',
          order: Number(entry.order) || 0,
          textId: typeof entry.textId === 'string' ? entry.textId : null
        })),
        transientSections: (state.transientSections ?? []).map((entry) => ({
          name: entry.name,
          anchor: entry.anchor ?? '__end__',
          order: Number(entry.order) || 0,
          activation: 'once',
          enabled: entry.enabled !== false,
          textId: typeof entry.textId === 'string' ? entry.textId : null
        })),
        toolPolicy: {
          allow: null,
          deny: [...(state.toolPolicy?.deny ?? [])]
        },
        updatedAt: Date.now()
      })
      store.savePresets(value)
      state.lastPreset = { id: presetId, name: presetName, at: Date.now() }
      state.presetModified = false
      state.presetStats = statsOfCurrent(sessionId, state, engine.describe(sessionId))
      saveStateOf(sessionId, state)
      return snapshot(sessionId)
    },

    async 'preset.usage' (body) {
      const presetId = text(body.id, 100)
      const usage = await presetUsage(presetId)
      return { id: presetId, ...usage }
    },

    async 'preset.delete' (body) {
      const sessionId = sessionOf(body)
      const presetId = text(body.id, 100)
      const removed = store.presets().presets.find((preset) => preset.id === presetId)
      if (removed === undefined) throw new Error('preset not found')
      const usage = await presetUsage(presetId)
      if (usage.count > 0 && body.force !== true) {
        throw new Error(`该预设仍被 ${usage.count} 个会话使用；确认后传 force: true`)
      }
      backupOf(sessionId, 'delete preset', 'auto')
      const value = clone(store.presets())
      value.presets = value.presets.filter((preset) => preset.id !== presetId)
      store.savePresets(value)

      const state = stateOf(sessionId)
      if (state.lastPreset?.id === presetId) {
        state.lastPreset = null
        state.presetModified = !sameConfigurationAsPreset(state, removed)
        state.presetStats = null
        saveStateOf(sessionId, state)
      }
      return {
        ...snapshot(sessionId),
        deleted: { id: presetId, name: removed.name, usage }
      }
    },

    'preset.apply' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      const presetId = text(body.id, 100)
      const preset = store.presets().presets.find((entry) => entry.id === presetId)
      if (preset === undefined) throw new Error('preset not found')
      const config = resolvePresetConfig(preset, sessionId)
      ensureDraft(sessionId)
      const stats = statsOfCurrent(sessionId, { overrides: config.overrides }, engine.describe(sessionId))
      backupOf(sessionId, `apply preset ${preset.name}`, 'auto')
      const state = stateOf(sessionId)
      state.overrides = config.overrides
      state.extras = config.extras
      state.transientSections = config.transientSections
      state.toolPolicy = config.toolPolicy
      state.lastPreset = { id: preset.id, name: preset.name, at: Date.now() }
      state.presetModified = false
      state.presetStats = stats
      saveStateOf(sessionId, state)
      toolPolicyChanged(sessionId)
      notifyTransientChanged(sessionId)
      engine.sync(sessionId)
      const value = snapshot(sessionId)
      value.applied = {
        id: preset.id,
        name: preset.name,
        stats,
        unresolved: config.unresolved,
        overrides: Object.keys(config.overrides).length,
        extras: config.extras.length,
        transientSections: config.transientSections.length,
        toolDeny: config.toolPolicy.deny.length
      }
      return value
    },

    'backup.create' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      if (draftContext(sessionId)) {
        throw new Error('草稿会话没有持久备份；请先开始一次对话')
      }
      const entry = store.backup(sessionId, typeof body.label === 'string' && body.label !== '' ? body.label : '手动快照', 'manual')
      return { ...snapshot(sessionId), created: entry }
    },

    'backup.restore' (body) {
      const sessionId = sessionOf(body)
      assertPromptEditable(sessionId)
      if (draftContext(sessionId)) {
        throw new Error('草稿会话不能恢复备份；请先开始一次对话')
      }
      const file = text(body.file, 200)
      const payload = store.readBackup(sessionId, file)
      if (payload?.version !== 3 || payload?.session?.prompt === undefined) {
        throw new Error('这是旧版备份，已不再支持恢复；请继续使用当前版本备份')
      }
      store.backup(sessionId, `恢复前快照 ${file}`, 'auto')
      const source = payload.session.prompt
      const library = clone(store.library())
      const savedFragments = new Map((payload.fragments ?? []).map((fragment) => [fragment.id, fragment]))
      const overrides = {}
      let mapped = 0
      let recreated = 0
      let unresolved = 0
      for (const [key, originalId] of Object.entries(source.overrides ?? {})) {
        if (isReadOnly(key)) continue
        const saved = savedFragments.get(originalId)
        const exact = saved === undefined
          ? undefined
          : library.fragments.find((fragment) =>
            fragment.key === key &&
            fragment.target !== 'insert' &&
            fragment.mode === saved.mode &&
            fragment.text === saved.text)
        if (exact !== undefined) {
          overrides[key] = exact.id
          mapped += 1
          continue
        }
        const original = library.fragments.find((fragment) =>
          fragment.id === originalId && fragment.key === key && fragment.target !== 'insert')
        if (original !== undefined) {
          overrides[key] = original.id
          mapped += 1
          continue
        }
        if (saved !== undefined) {
          const fragmentId = id('frag')
          library.fragments.push({
            id: fragmentId,
            key,
            label: label(saved.label, '默认'),
            mode: saved.mode === 'empty' ? 'empty' : 'replace',
            target: 'override',
            activation: 'persistent',
            text: typeof saved.text === 'string' ? saved.text : '',
            baseHash: saved.baseHash ?? null,
            baseText: typeof saved.baseText === 'string' ? saved.baseText : '',
            ...(saved.awaitingBaseline === true ? { awaitingBaseline: true } : {}),
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
          overrides[key] = fragmentId
          recreated += 1
          continue
        }
        unresolved += 1
      }

      let textUnresolved = 0
      const resolveText = (entry, activation) => {
        if (typeof entry.textId === 'string' && entry.textId !== '') {
          const linked = library.fragments.find((fragment) =>
            fragment.id === entry.textId && fragment.target === 'insert')
          if (linked !== undefined) return linked
        }
        const value = typeof entry.text === 'string' ? entry.text : ''
        if (value.trim() === '') return null
        const exact = library.fragments.find((fragment) =>
          fragment.target === 'insert' && fragment.key === entry.name && fragment.text === value)
        if (exact !== undefined) return exact
        const now = Date.now()
        const fragment = {
          id: id('frag'),
          key: entry.name,
          label: nextDefaultLabel(library.fragments),
          mode: 'replace',
          target: 'insert',
          activation: activationOf(activation),
          text: value,
          baseHash: null,
          baseText: '',
          createdAt: now,
          updatedAt: now
        }
        library.fragments.push(fragment)
        recreated += 1
        return fragment
      }

      const extras = []
      for (const entry of source.extras ?? []) {
        if (isReadOnly(entry.name)) continue
        const fragment = resolveText(entry, 'persistent')
        if (fragment === null) {
          textUnresolved += 1
          continue
        }
        extras.push({
          id: id('extra'),
          name: entry.name,
          anchor: entry.anchor ?? '__end__',
          order: Number(entry.order) || 0,
          text: fragment.text,
          textId: fragment.id
        })
      }
      const transientSections = []
      for (const entry of source.transientSections ?? []) {
        if (isReadOnly(entry.name)) continue
        const fragment = resolveText(entry, entry.activation)
        if (fragment === null) {
          textUnresolved += 1
          continue
        }
        transientSections.push({
          id: id('transient'),
          name: entry.name,
          anchor: entry.anchor ?? '__end__',
          order: Number(entry.order) || 0,
          text: fragment.text,
          textId: fragment.id,
          activation: 'once',
          enabled: entry.enabled !== false,
          consumedAtTurn: null,
          updatedAt: Date.now()
        })
      }
      if (mapped + recreated > 0) store.saveLibrary(library)

      const state = clone(store.state(sessionId))
      state.overrides = overrides
      state.extras = extras
      state.transientSections = transientSections
      state.toolPolicy = {
        allow: null,
        deny: [...new Set(
          (payload.session.capabilities?.toolPolicy?.deny ?? []).filter((name) => typeof name === 'string')
        )]
      }
      // Backups deliberately do not record the preset page.
      state.lastPreset = null
      state.presetModified = false
      state.presetStats = null
      store.saveState(sessionId, state)
      toolPolicyChanged(sessionId)
      notifyTransientChanged(sessionId)
      engine.sync(sessionId)
      return {
        ...snapshot(sessionId),
        restored: {
          version: 3,
          mapped,
          recreated,
          unresolved,
          textUnresolved
        }
      }
    },

    'config.get' () {
      return {
        settings: settingsOf(),
        dataDir,
        bootstrapDir: bootstrapDir(),
        defaultDataDir: defaultDataDir(),
        previousDataDir: settingsOf().previousDataDir ?? null,
        pendingMigration: settingsOf().pendingMigration ?? null
      }
    },

    'config.cleanupOldData' () {
      const previous = settingsOf().previousDataDir
      if (typeof previous !== 'string' || previous === '') {
        throw new Error('没有待清理的旧数据目录')
      }
      const result = cleanupDataDirs(previous, {
        currentDir: dataDir,
        bootstrapDir: bootstrapDir()
      })
      if (result.ok !== true) throw new Error(result.error)
      persist({ previousDataDir: null })
      return {
        settings: settingsOf(),
        dataDir,
        bootstrapDir: bootstrapDir(),
        defaultDataDir: defaultDataDir(),
        cleaned: result
      }
    },

    /**
     * Delete every Prompt Lab-owned data file (library, presets, all session
     * state/backups, drafts), but keep the bootstrap config. Active
     * registrations are disposed, so live sessions immediately return to the
     * official prompt.
     */
    async 'config.purgeArchived' (body) {
      const ids = store.listSessionIds()
      let livenessMap = new Map()
      try {
        livenessMap = await livenessOf(ids)
      } catch {
        livenessMap = new Map(ids.map((id) => [id, { id, status: 'unknown', title: null }]))
      }
      const targets = ids.filter((id) => {
        const status = livenessMap.get(id)?.status
        return status === 'archived' || status === 'missing'
      })
      if (body?.preview === true) {
        return { targets, count: targets.length }
      }
      const removed = []
      for (const id of targets) {
        const ok = typeof purgeSessionData === 'function' ? purgeSessionData(id) : store.deleteSessionData(id)
        if (ok !== false) removed.push(id)
      }
      return { removed, count: removed.length, targets }
    },

    async 'config.wipeAllData' (body) {
      const sessionId = sessionOf(body)
      let result
      if (typeof wipeAllData === 'function') {
        result = await wipeAllData()
      } else {
        result = store.wipeAll()
        try {
          engine.shutdown()
        } catch {
          /* registrations are best-effort */
        }
      }
      return { ...snapshot(sessionId), wiped: result }
    },

    /**
     * Update limits live, and/or point the plugin at another data directory.
     * A path change only schedules the copy; the actual migration runs on the
     * next DSH start, before Store is opened, so the running session never sees
     * a half-moved directory.
     */
    'config.set' (body) {
      const patch = {}
      let migration = null
      if (body.dataDir !== undefined) {
        if (dataDirSource === 'patch') {
          throw new Error('dataDir 由 cordis.patch.yml 固定，面板不能修改')
        }
        const target = validateDataDir(body.dataDir)
        if (!('dir' in target)) throw new Error(target.error)
        if (target.dir !== dataDir) {
          // If the running data dir is empty (e.g. a pre-migration empty target)
          // but the bootstrap default still holds the real data, migrate from
          // the default instead of copying an empty tree.
          let sourceDir = dataDir
          const fallbackDir = bootstrapDir()
          if (fallbackDir !== dataDir &&
              !hasMeaningfulData(dataDir) &&
              hasMeaningfulData(fallbackDir)) {
            sourceDir = fallbackDir
          }
          if (sourceDir === target.dir) {
            patch.dataDir = target.dir
            patch.pendingMigration = null
          } else {
            const pathError = migrationPathError(sourceDir, target.dir, { bootstrapDir: bootstrapDir() })
            if (pathError !== null) throw new Error(pathError)
            if (targetHasContents(target.dir, { bootstrapDir: bootstrapDir() })) {
              throw new Error('新数据目录不是空目录；请选择空目录后再保存')
            }
            patch.dataDir = target.dir
            migration = { from: sourceDir, to: target.dir, at: Date.now() }
            patch.pendingMigration = migration
          }
        } else {
          // Re-saving the current directory cancels a pending move.
          patch.dataDir = target.dir
          patch.pendingMigration = null
        }
      }
      for (const key of Object.keys(CONFIG_LIMITS)) {
        if (body[key] === undefined) continue
        const bound = CONFIG_LIMITS[key]
        const number = Number(body[key])
        if (!Number.isFinite(number)) throw new Error(`${key} 必须是数字`)
        if (number < bound.min || number > bound.max) throw new Error(`${key} 必须在 ${bound.min}–${bound.max} 之间`)
        patch[key] = Math.round(number)
      }
      if (Object.keys(patch).length === 0) throw new Error('没有要修改的内容')
      persist(patch)
      return {
        settings: settingsOf(),
        dataDir,
        bootstrapDir: bootstrapDir(),
        defaultDataDir: defaultDataDir(),
        previousDataDir: settingsOf().previousDataDir ?? null,
        pendingMigration: settingsOf().pendingMigration ?? null,
        migration,
        restartRequired: patch.dataDir !== undefined && patch.dataDir !== dataDir
      }
    }
  }

  async function handle (body) {
    const op = typeof body?.op === 'string' ? body.op : ''
    const handler = handlers[op]
    if (handler === undefined) throw new Error(`unknown op "${op}"`)
    return handler(body ?? {})
  }

  return { handle, snapshot, paths: { route: ROUTE } }
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error?.message ?? error}`))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

/**
 * Reject cross-site browser writes. The route is registered on the Harness's
 * own loopback web server and therefore inherits no CSRF protection from the
 * WebSocket API gateway. A `text/plain` POST from an arbitrary page is a CORS
 * "simple request", so checking Origin alone is not enough: the content type
 * must be JSON (which forces a preflight for cross-origin requests).
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null} an error message, or null when the request is acceptable
 */
function isLoopbackAddress (address) {
  if (typeof address !== 'string') return false
  const value = address.toLowerCase().split('%')[0]
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (value.startsWith('::ffff:')) return /^127\./.test(value.slice(7))
  return /^127\./.test(value)
}

function isLoopbackHostname (hostname) {
  const value = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value)
}

/**
 * Reject writes that are not demonstrably same-origin loopback browser calls.
 * This API has no independent user authentication, so it must not become a
 * network-facing control surface. Requiring JSON also prevents simple-form
 * CSRF requests; requiring a literal loopback Host prevents DNS-rebinding
 * origins from passing merely because Origin and Host match.
 *
 * Origin is optional because some DSH Web hosts (including the Electron
 * shell) omit it on same-origin POST requests. When present it must match the
 * loopback Host exactly; when absent, the loopback socket, loopback Host,
 * JSON content type and Sec-Fetch-Site still bound the request.
 */
function rejectForeignWrite (req) {
  const headers = req.headers ?? {}
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return 'cross-site requests are not allowed'
  }

  const remoteAddress = req.socket?.remoteAddress ?? req.connection?.remoteAddress
  if (!isLoopbackAddress(remoteAddress)) {
    return 'API requests must originate from the local machine'
  }

  const host = headers.host
  if (typeof host !== 'string' || host === '') {
    return 'Host header is required'
  }

  let requestUrl
  try {
    requestUrl = new URL(`http://${host}`)
  } catch {
    return 'invalid Host header'
  }
  if (
    requestUrl.username !== '' ||
    requestUrl.password !== '' ||
    requestUrl.pathname !== '/' ||
    requestUrl.search !== '' ||
    requestUrl.hash !== '' ||
    !isLoopbackHostname(requestUrl.hostname)
  ) {
    return 'API Host must be localhost or a loopback address'
  }

  const origin = headers.origin
  if (origin !== undefined) {
    if (typeof origin !== 'string' || origin === '') {
      return 'invalid Origin header'
    }
    if (origin === 'null') {
      return 'null Origin is not allowed'
    }

    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      return 'invalid Origin header'
    }
    const expectedProtocol = req.socket?.encrypted === true ? 'https:' : 'http:'
    if (
      originUrl.protocol !== expectedProtocol ||
      originUrl.username !== '' ||
      originUrl.password !== '' ||
      originUrl.pathname !== '/' ||
      originUrl.search !== '' ||
      originUrl.hash !== ''
    ) {
      return 'invalid Origin header'
    }
    if (
      !isLoopbackHostname(originUrl.hostname) ||
      originUrl.host.toLowerCase() !== host.toLowerCase()
    ) {
      return 'cross-origin requests are not allowed'
    }
  }

  const type = headers['content-type']
  if (
    typeof type !== 'string' ||
    !/^application\/json(?:\s*;|$)/i.test(type)
  ) {
    return 'content-type must be application/json'
  }
  return null
}

/** HTTP handler registered on the Harness web server. */
export function createHandler (api, logger) {
  return async function handler (req, res) {
    const send = (status, value) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.end(JSON.stringify(value))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== ROUTE && !url.pathname.startsWith(`${ROUTE}/`)) {
        return send(404, { ok: false, error: 'not found' })
      }
      const tail = url.pathname.slice(ROUTE.length)
      if (req.method === 'GET' && (tail === '/health' || tail === '')) {
        return send(200, { ok: true, value: { alive: true } })
      }
      if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' })
      const foreign = rejectForeignWrite(req)
      if (foreign !== null) {
        req.resume()
        return send(403, { ok: false, error: foreign })
      }
      const body = await readBody(req)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('body must be a JSON object')
      }
      const value = await api.handle(body)
      return send(200, { ok: true, value })
    } catch (error) {
      try {
        logger?.warn?.(`prompt-lab api: ${error?.message ?? error}`)
      } catch {
        /* ignore */
      }
      return send(200, { ok: false, error: String(error?.message ?? error) })
    }
  }
}
