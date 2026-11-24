/**
 * Persistent storage for Prompt Lab.
 *
 * Layout under <dataDir>:
 *   library/sections.json   section text entries (the unit of "per-section save")
 *   library/messages.json   reusable message text entries (P6)
 *   library/presets.json    named groups of fragment ids
 *   sessions/<id>/state.json
 *   sessions/<id>/backups/<time>-<kind>-<rand>.json
 *
 * The bootstrap directory (`~/.dsh/plugins/dsh-prompt-lab`) always holds
 * `config.json`; it is the only fixed location, so the plugin can find the
 * user's chosen data directory and limits before anything else exists.
 *
 * Every write is atomic (tmp + rename). Reads degrade to defaults instead of
 * throwing, so a corrupt file turns the panel read-only rather than breaking
 * the Harness.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertNoSymlinkPath } from './path-guard.js'
import {
  OWNER_MARKER_FILE,
  WORKSPACE_WARNING_FILE,
  ensureOwnerMarker,
  isOwnedDataDir
} from './workspace-warning.js'

/**
 * Session ids become path segments. The first character must be alphanumeric:
 * allowing `.`/`..` (which the previous pattern did) made `sessions/..`
 * resolve to the data root, so a crafted API call could read or write
 * `state.json` and `backups/` outside `sessions/`.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Everything the panel may tune. Persisted in the bootstrap config.json. */
export const DEFAULT_CONFIG = {
  presetLimit: 10,
  autoBackupLimit: 20,
  manualBackupLimit: 5
}

export const CONFIG_LIMITS = {
  presetLimit: { min: 1, max: 200 },
  autoBackupLimit: { min: 1, max: 500 },
  manualBackupLimit: { min: 1, max: 500 }
}

/** @param {string} text */
export function sha16 (text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

/**
 * DeepSeek's practical rule of thumb: a CJK code point costs about 0.6 token,
 * every other code point about 0.3. The result is rounded up and displayed
 * with a `~` prefix, because this is an estimate, not a tokenizer count.
 * @param {string} text
 */
export function estimateTokens (text) {
  const value = String(text ?? '')
  if (value === '') return 0
  let tokens = 0
  for (const char of value) {
    tokens += char.codePointAt(0) >= 0x2e80 ? 0.6 : 0.3
  }
  return Math.ceil(tokens)
}

/**
 * Sensitivity tiers. Everything else — file-reference conventions, structured
 * output, source paths, and every user-added section — is unmarked.
 *  - capability: what the model may do (tools, sandbox, MCP, delegation)
 *  - policy: how it must behave (planning, team rules)
 *  - persona: voice and character only
 * @param {string} name
 * @returns {'capability' | 'policy' | 'persona' | null}
 */
export function sensitivityOf (name) {
  const value = String(name ?? '')
  if (/^(tool:|tools:|sandbox:|mcp|subagent:|computer-use:)/.test(value)) return 'capability'
  if (/^(plan:|team:)/.test(value)) return 'policy'
  if (/^harness:identity$/.test(value) || /persona/.test(value)) return 'persona'
  return null
}

/**
 * Section names shipped by the DSH installation itself. Anything outside this
 * list is treated as plugin-provided: that is a factual statement about the
 * name, not a risk judgement. The list is maintained against
 * {@link CLASSIFIED_AGAINST} and lives here (not in the engine) so the panel's
 * library view can reuse it without importing engine internals.
 */
export const OFFICIAL_SECTIONS = new Set([
  'harness:identity', 'harness:source', 'app:web-surface',
  'deployment:persona-prefix', 'deployment:persona-suffix',
  'plan:policy', 'plan', 'team:policy', 'team:identity',
  'context:file-reference', 'mcp-resource-servers',
  'ui:deliverable-file-references', 'tools:sdk', 'tools:ptc-only',
  'structured-output', 'tool:bash', 'tool:pwsh', 'tool:read', 'tool:write',
  'tool:edit', 'tool:apply_patch', 'tool:glob', 'tool:grep', 'tool:jobs', 'tool:pty',
  'tool:pty-panel', 'tool:web_search', 'tool:web_fetch', 'tool:lsp', 'tool:session-query',
  'tool:goal', 'tool:schedule', 'tool:workflow', 'tool:ralph', 'tool:subagent',
  'tool:subagent_fork', 'tool:report', 'tool:structured_output',
  'computer-use:dsh-cua'
])

/**
 * @param {string} name
 * @returns {'official' | 'plugin'}
 */
export function sectionSource (name) {
  return OFFICIAL_SECTIONS.has(String(name ?? '')) ? 'official' : 'plugin'
}

/** DSH release the source/risk classification was written against. */
export const CLASSIFIED_AGAINST = '0.2.2-rc.3'

/**
 * Sections the Harness owns as tool/capability protocol. Prompt Lab must not
 * rewrite them: tool availability will be controlled by a dedicated tool
 * switch, and editing their prose would let the prompt disagree with the
 * actual tool registry. They are shown read-only.
 */
export function isReadOnlySection (name) {
  const value = String(name ?? '')
  return /^tool:/.test(value) ||
    /^tools:/.test(value) ||
    /^computer-use:/.test(value) ||
    value === 'mcp-resource-servers' ||
    value === 'structured-output'
}

/**
 * Resolve the Harness home the same way DSH does: `$DSH_HOME`, then `~/.dsh`.
 * `~` and `~/...` are expanded because DSH accepts them.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveDshHome (env = process.env) {
  const raw = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (raw === '') return path.join(os.homedir(), '.dsh')
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2))
  return path.resolve(raw)
}

/** Fixed bootstrap directory: config.json lives here and nowhere else. */
export function bootstrapDir () {
  return path.join(resolveDshHome(), 'plugins', 'dsh-prompt-lab')
}

export function defaultDataDir () {
  return bootstrapDir()
}

function inside (parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Resolve symlinks in the longest existing prefix, then append the missing
 * suffix. path.resolve() alone is lexical and can let a symlinked directory
 * bypass the workspace boundary check.
 */
function canonicalCandidate (candidate) {
  const absolute = path.resolve(candidate)
  let cursor = absolute
  const suffix = []
  while (true) {
    try {
      const real = fs.realpathSync.native(cursor)
      return path.join(real, ...suffix.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      suffix.push(path.basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Validate one candidate data directory.
 * The workspace is rejected: session data there would be tracked, synced, and
 * editable by the very agent the plugin configures.
 * @param {unknown} raw
 * @returns {{ dir: string } | { error: string }}
 */
export function validateDataDir (raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { error: '路径不能为空' }
  const value = raw.trim().replace(/^"|"$/g, '')
  if (!path.isAbsolute(value)) return { error: '必须是绝对路径，例如 D:\\DSH-data\\prompt-lab' }
  let resolved
  let cwd
  try {
    resolved = canonicalCandidate(value)
    cwd = canonicalCandidate(process.cwd())
  } catch (error) {
    return { error: `无法解析数据目录：${error?.message ?? error}` }
  }
  if (resolved === path.parse(resolved).root) return { error: '不能使用磁盘根目录作为数据目录' }
  if (resolved === cwd || inside(cwd, resolved)) {
    return { error: '不能放在工作区内（会被 git 跟踪、也会被 agent 改坏）' }
  }
  try {
    fs.mkdirSync(resolved, { recursive: true })
    // Re-resolve after creation so a pre-existing symlink in the path cannot
    // change the effective destination between validation and the write probe.
    resolved = canonicalCandidate(resolved)
    if (resolved === cwd || inside(cwd, resolved)) {
      return { error: '不能放在工作区内（会被 git 跟踪、也会被 agent 改坏）' }
    }
    const probe = path.join(resolved, `.write-test-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
  } catch (error) {
    return { error: `目录不可写：${error?.message ?? error}` }
  }
  return { dir: resolved }
}

function clampLimit (key, value) {
  const bound = CONFIG_LIMITS[key]
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_CONFIG[key]
  return Math.min(bound.max, Math.max(bound.min, Math.round(number)))
}

/**
 * Read and normalize the user-editable bootstrap config.
 * @returns {{ dataDir?: string, presetLimit: number, autoBackupLimit: number, manualBackupLimit: number, pendingMigration?: { from: string, to: string, at: number }, previousDataDir?: string }}
 */
export function readBootstrapConfig () {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(path.join(bootstrapDir(), 'config.json'), 'utf8')) ?? {}
  } catch {
    raw = {}
  }
  const value = raw && typeof raw === 'object' ? raw : {}
  const pending = value.pendingMigration
  const pendingMigration = pending && typeof pending === 'object' &&
    typeof pending.from === 'string' && pending.from.trim() !== '' &&
    typeof pending.to === 'string' && pending.to.trim() !== ''
    ? {
        from: pending.from.trim(),
        to: pending.to.trim(),
        at: Number.isFinite(pending.at) ? pending.at : 0
      }
    : undefined
  return {
    ...(typeof value.dataDir === 'string' && value.dataDir.trim() !== '' ? { dataDir: value.dataDir.trim() } : {}),
    presetLimit: clampLimit('presetLimit', value.presetLimit),
    autoBackupLimit: clampLimit('autoBackupLimit', value.autoBackupLimit),
    manualBackupLimit: clampLimit('manualBackupLimit', value.manualBackupLimit),
    ...(pendingMigration === undefined ? {} : { pendingMigration }),
    ...(typeof value.previousDataDir === 'string' && value.previousDataDir.trim() !== '' ? { previousDataDir: value.previousDataDir.trim() } : {})
  }
}

/**
 * Persist the bootstrap config. Atomic like every other write.
 * @param {Record<string, unknown>} value
 */
export function writeBootstrapConfig (value) {
  const dir = bootstrapDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'config.json')
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Resolve the effective data directory at startup.
 * Precedence: profile patch `config.dataDir` > bootstrap config.json > default.
 * A bad value is reported and skipped, never fatal.
 * @param {{ dataDir?: string } | undefined} config
 * @param {string[]} warnings
 */
export function resolveDataDir (config, warnings) {
  const fromPatch = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (fromPatch !== '') {
    const result = validateDataDir(fromPatch)
    if ('dir' in result) return result.dir
    warnings.push(`配置里的 dataDir 被忽略：${result.error}`)
    return defaultDataDir()
  }
  const fromPanel = readBootstrapConfig().dataDir
  if (typeof fromPanel === 'string' && fromPanel !== '') {
    const result = validateDataDir(fromPanel)
    if ('dir' in result) return result.dir
    warnings.push(`面板保存的 dataDir 被忽略：${result.error}`)
  }
  return defaultDataDir()
}

export const LIBRARY_VERSION = 3
export const DRAFT_VERSION = 1
export const PRESET_VERSION = 3
export const BACKUP_VERSION = 3
/** Message text entries are global and never referenced by presets/backups. */
export const MESSAGE_LIBRARY_VERSION = 1
export const MESSAGE_TEXT_LIMIT = 200_000
export const MESSAGE_ENTRY_LIMIT = 500
/** A draft only lives this long without being seen; archived sessions keep theirs until then. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_DRAFT_TEXT = 200_000

export const SECTION_ACTIVATIONS = ['persistent', 'once']

function normalizeActivation (value, fallback = 'persistent') {
  return value === 'once' || value === 'persistent' ? value : fallback
}

function emptyLibrary () {
  return { version: LIBRARY_VERSION, fragments: [] }
}

function emptyMessageLibrary () {
  return { version: MESSAGE_LIBRARY_VERSION, entries: [] }
}

/** Next unused auto label: 默认, 默认1, 默认2, … */
export function nextDefaultLabel (items, base = '默认') {
  const used = new Set((items ?? []).map((item) => String(item?.label ?? '')))
  if (!used.has(base)) return base
  let index = 1
  while (used.has(`${base}${index}`)) index += 1
  return `${base}${index}`
}

/**
 * Normalize one fragment template. The shape is v2: fragments may share a
 * `key`, each has its own id, label, mode, text, and base hash.
 * @param {any} fragment
 * @param {number} index
 */
function normalizeFragment (fragment, index) {
  const source = fragment && typeof fragment === 'object' ? fragment : {}
  const now = Date.now()
  const updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : now
  const createdAt = Number.isFinite(source.createdAt) ? source.createdAt : updatedAt
  return {
    ...source,
    id: typeof source.id === 'string' && source.id !== '' ? source.id : `frag_migrated_${index}`,
    key: typeof source.key === 'string' ? source.key : '',
    label: typeof source.label === 'string' && source.label.trim() !== '' ? source.label : '默认',
    mode: source.mode === 'empty' ? 'empty' : 'replace',
    // P6: `target` distinguishes an official-section override from a reusable
    // text entry that can be inserted as a new section. `activation` is the
    // insert-time default; the session keeps its own copy once inserted.
    target: source.target === 'insert' ? 'insert' : 'override',
    activation: normalizeActivation(source.activation),
    text: typeof source.text === 'string' ? source.text : '',
    baseHash: typeof source.baseHash === 'string' ? source.baseHash : null,
    baseText: typeof source.baseText === 'string' ? source.baseText : '',
    createdAt,
    updatedAt
  }
}

function normalizeMessageEntry (entry, index) {
  const source = entry && typeof entry === 'object' ? entry : {}
  const now = Date.now()
  const updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : now
  const createdAt = Number.isFinite(source.createdAt) ? source.createdAt : updatedAt
  return {
    ...source,
    id: typeof source.id === 'string' && source.id !== '' ? source.id : `msg_migrated_${index}`,
    label: typeof source.label === 'string' && source.label.trim() !== '' ? source.label : '默认',
    text: typeof source.text === 'string' ? source.text : '',
    createdAt,
    updatedAt
  }
}

function normalizeMessageLibrary (raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const entries = Array.isArray(source.entries)
    ? source.entries.filter((entry) => entry && typeof entry === 'object').map(normalizeMessageEntry)
    : []
  return { ...source, version: MESSAGE_LIBRARY_VERSION, entries }
}

function normalizeLibrary (raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const fragments = Array.isArray(source.fragments)
    ? source.fragments.filter((fragment) => fragment && typeof fragment === 'object').map(normalizeFragment)
    : []
  return { ...source, version: LIBRARY_VERSION, fragments }
}

function emptyPresets () {
  return { version: PRESET_VERSION, presets: [] }
}

function normalizeToolPolicy (value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    allow: Array.isArray(source.allow)
      ? source.allow.filter((entry) => typeof entry === 'string')
      : null,
    deny: Array.isArray(source.deny)
      ? [...new Set(source.deny.filter((entry) => typeof entry === 'string'))]
      : []
  }
}

function normalizePresetEntry (preset, index) {
  if (!preset || typeof preset !== 'object' || preset.version !== PRESET_VERSION) return null
  const now = Date.now()
  const updatedAt = Number.isFinite(preset.updatedAt) ? preset.updatedAt : now
  const extras = Array.isArray(preset.extras)
    ? preset.extras
      .filter((entry) => entry && typeof entry.name === 'string')
      .map((entry) => ({
        name: entry.name,
        anchor: typeof entry.anchor === 'string' && entry.anchor !== '' ? entry.anchor : '__end__',
        order: Number.isFinite(entry.order) ? entry.order : 0,
        textId: typeof entry.textId === 'string' && entry.textId !== '' ? entry.textId : null
      }))
    : []
  const transientSections = Array.isArray(preset.transientSections)
    ? preset.transientSections
      .filter((entry) => entry && typeof entry.name === 'string')
      .map((entry) => ({
        name: entry.name,
        anchor: typeof entry.anchor === 'string' && entry.anchor !== '' ? entry.anchor : '__end__',
        order: Number.isFinite(entry.order) ? entry.order : 0,
        activation: 'once',
        enabled: entry.enabled !== false,
        textId: typeof entry.textId === 'string' && entry.textId !== '' ? entry.textId : null
      }))
    : []
  return {
    ...preset,
    version: PRESET_VERSION,
    id: typeof preset.id === 'string' && preset.id !== '' ? preset.id : `preset_migrated_${index}`,
    name: typeof preset.name === 'string' && preset.name.trim() !== '' ? preset.name : '未命名预设',
    note: typeof preset.note === 'string' ? preset.note : '',
    fragmentIds: Array.isArray(preset.fragmentIds)
      ? preset.fragmentIds.filter((entry) => typeof entry === 'string')
      : [],
    extras,
    transientSections,
    toolPolicy: normalizeToolPolicy(preset.toolPolicy),
    updatedAt
  }
}

function normalizePresets (raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const presets = Array.isArray(source.presets)
    ? source.presets
      .map(normalizePresetEntry)
      .filter((preset) => preset !== null)
    : []
  return { ...source, version: PRESET_VERSION, presets }
}

export function emptySession () {
  return {
    version: 1,
    enabled: false,
    overrides: {},
    extras: [],
    structureHash: null,
    lastPreset: null,
    presetModified: false,
    presetStats: null,
    committed: true,
    firstSeenAt: 0,
    lastSeenAt: 0,
    lastCapture: null,
    updatedAt: 0,
    // 0.3.0 capability state is defined now so drafts/state can carry it
    // without changing assembly yet. P0 stores it but does not apply it.
    toolPolicy: { allow: null, deny: [] },
    transientSections: [],
    autoAssistant: { enabled: false, text: '' }
  }
}

/**
 * Fill capability fields for old state/draft files. P0 only carries these
 * fields; applying them starts in later phases.
 */
export function normalizeCapabilityState (state) {
  if (!state || typeof state !== 'object') return state
  const tool = state.toolPolicy && typeof state.toolPolicy === 'object' && !Array.isArray(state.toolPolicy)
    ? state.toolPolicy
    : {}
  state.toolPolicy = {
    allow: Array.isArray(tool.allow)
      ? tool.allow.filter((entry) => typeof entry === 'string')
      : null,
    deny: Array.isArray(tool.deny)
      ? tool.deny.filter((entry) => typeof entry === 'string')
      : []
  }
  state.transientSections = Array.isArray(state.transientSections)
    ? state.transientSections
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        ...entry,
        text: typeof entry.text === 'string' ? entry.text : '',
        textId: typeof entry.textId === 'string' && entry.textId !== '' ? entry.textId : null
      }))
    : []
  state.extras = Array.isArray(state.extras)
    ? state.extras
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        ...entry,
        text: typeof entry.text === 'string' ? entry.text : '',
        textId: typeof entry.textId === 'string' && entry.textId !== '' ? entry.textId : null
      }))
    : []
  const auto = state.autoAssistant && typeof state.autoAssistant === 'object' && !Array.isArray(state.autoAssistant)
    ? state.autoAssistant
    : {}
  state.autoAssistant = {
    enabled: auto.enabled === true,
    text: typeof auto.text === 'string' ? auto.text : '',
    textId: typeof auto.textId === 'string' && auto.textId !== '' ? auto.textId : null
  }
  return state
}

function emptyDraft (sessionId) {
  return {
    version: DRAFT_VERSION,
    sessionId: String(sessionId),
    createdAt: 0,
    updatedAt: 0,
    lastSeenAt: 0,
    closedAt: 0,
    state: { ...emptySession(), enabled: false, committed: false },
    fragments: []
  }
}

export class Store {  /**
   * @param {string} dir absolute data directory
   * @param {string[]} warnings writable diagnostic list surfaced to the panel
   * @param {() => { autoBackupLimit: number, manualBackupLimit: number }} limits
   */
  constructor (dir, warnings, limits, options = {}) {
    this.dir = dir
    this.warnings = warnings
    this.limits = typeof limits === 'function' ? limits : () => ({ autoBackupLimit: 20, manualBackupLimit: 5 })
    this.isReadOnly = typeof options.isReadOnlySection === 'function' ? options.isReadOnlySection : isReadOnlySection
    this.readonly = false
    this.cache = { library: null, messages: null, presets: null, sessions: new Map(), drafts: new Map(), locked: new Map() }
  }

  ensure () {
    fs.mkdirSync(this.dir, { recursive: true })
    this.dir = fs.realpathSync.native(this.dir)
    for (const name of ['library', 'sessions', 'drafts', 'pending']) {
      const target = path.join(this.dir, name)
      fs.mkdirSync(target, { recursive: true })
      assertNoSymlinkPath(this.dir, target)
    }
    // Best-effort ownership proof for wipe/cleanup. A failure is reported by the
    // warning path in index.js, not thrown into startup.
    const marker = ensureOwnerMarker({ dataDir: this.dir })
    if (marker.ok !== true) this.warn(`cannot write the owner marker: ${marker.error}`)
  }

  warn (message) {
    if (this.warnings.length < 50) this.warnings.push(message)
  }

  _read (file, fallback) {
    try {
      assertNoSymlinkPath(this.dir, file)
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`cannot read ${path.basename(file)}: ${error?.message ?? error}`)
      return fallback
    }
  }

  _write (file, value) {
    assertNoSymlinkPath(this.dir, file)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    assertNoSymlinkPath(this.dir, file)
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  libraryPath () {
    const file = path.join(this.dir, 'library', 'sections.json')
    assertNoSymlinkPath(this.dir, file)
    return file
  }

  presetsPath () {
    const file = path.join(this.dir, 'library', 'presets.json')
    assertNoSymlinkPath(this.dir, file)
    return file
  }

  messagesPath () {
    const file = path.join(this.dir, 'library', 'messages.json')
    assertNoSymlinkPath(this.dir, file)
    return file
  }

  // preset-editor: Agent preset definitions (registered through ctx.agentPresets).
  // Stored next to the other libraries so `wipeAll()` already removes them, and
  // read through the same symlink-guarded helpers as every other file here.
  agentPresetsPath () {
    const file = path.join(this.dir, 'library', 'agent-presets.json')
    assertNoSymlinkPath(this.dir, file)
    return file
  }

  readAgentPresets (fallback) {
    return this._read(this.agentPresetsPath(), fallback)
  }

  writeAgentPresets (value) {
    this._write(this.agentPresetsPath(), value)
  }

  sessionDir (sessionId) {
    const id = String(sessionId ?? '')
    if (!SESSION_ID.test(id) || id === '.' || id === '..') throw new Error('invalid session id')
    const dir = path.join(this.dir, 'sessions', id)
    assertNoSymlinkPath(this.dir, dir)
    return dir
  }

  lockedPath (sessionId) {
    return path.join(this.sessionDir(sessionId), 'locked.json')
  }

  /** Read-only prompt snapshot created when the session's first turn starts. */
  lockedSnapshot (sessionId) {
    const id = String(sessionId)
    if (this.cache.locked.has(id)) return this.cache.locked.get(id)
    const value = this._read(this.lockedPath(id), null)
    const snapshot = value && typeof value === 'object' && value.version === 1 && Array.isArray(value.sections)
      ? value
      : null
    this.cache.locked.set(id, snapshot)
    return snapshot
  }

  saveLockedSnapshot (sessionId, snapshot) {
    const id = String(sessionId)
    const value = {
      version: 1,
      sessionId: id,
      lockedAt: snapshot.lockedAt ?? Date.now(),
      firstTurn: Number.isFinite(snapshot.firstTurn) ? snapshot.firstTurn : null,
      source: typeof snapshot.source === 'string' ? snapshot.source : 'first-turn',
      sections: Array.isArray(snapshot.sections) ? snapshot.sections : []
    }
    this._write(this.lockedPath(id), value)
    this.cache.locked.set(id, value)
    return value
  }

  isLocked (sessionId) {
    return this.lockedSnapshot(sessionId) !== null
  }

  /** Locked sessions delete their edit backups: restore is disabled anyway. */
  deleteBackups (sessionId) {
    const dir = path.join(this.sessionDir(sessionId), 'backups')
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      this.warn(`cannot remove session backups: ${error?.message ?? error}`)
    }
  }

  /** Remove every plugin-owned file for one session, keeping global libraries. */
  deleteSessionData (sessionId) {
    const id = String(sessionId)
    try {
      fs.rmSync(this.sessionDir(id), { recursive: true, force: true })
    } catch (error) {
      this.warn(`cannot remove session data: ${error?.message ?? error}`)
      return false
    }
    this.cache.sessions.delete(id)
    this.cache.locked.delete(id)
    return true
  }

  /**
   * Every persisted session directory with a legal id. Used by the fragment
   * library to compute cross-session references; a missing `sessions/` folder
   * is "no sessions", never an error.
   * @returns {string[]}
   */
  listSessionIds () {
    try {
      assertNoSymlinkPath(this.dir, path.join(this.dir, 'sessions'))
      return fs.readdirSync(path.join(this.dir, 'sessions'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SESSION_ID.test(entry.name))
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }

  library () {
    if (this.cache.library === null) {
      this.cache.library = normalizeLibrary(this._read(this.libraryPath(), null))
    }
    return this.cache.library
  }

  saveLibrary (value) {
    const normalized = normalizeLibrary(value)
    this._write(this.libraryPath(), normalized)
    this.cache.library = normalized
    return normalized
  }

  messageLibrary () {
    if (this.cache.messages === null) {
      const raw = this._read(this.messagesPath(), null)
      this.cache.messages = raw === null ? emptyMessageLibrary() : normalizeMessageLibrary(raw)
    }
    return this.cache.messages
  }

  saveMessageLibrary (value) {
    const normalized = normalizeMessageLibrary(value)
    this._write(this.messagesPath(), normalized)
    this.cache.messages = normalized
    return normalized
  }

  messageEntryById (entryId) {
    if (typeof entryId !== 'string' || entryId === '') return undefined
    return this.messageLibrary().entries.find((entry) => entry.id === entryId)
  }

  /** Resolve a persistent message text reference, falling back to its cache. */
  messageTextOf (value) {
    const entry = this.messageEntryById(value?.textId)
    if (entry !== undefined) return entry.text
    return typeof value?.text === 'string' ? value.text : ''
  }

  /**
   * Resolve a section text reference for extras/transients. The library is the
   * source of truth once `textId` exists; the inline `text` only covers legacy
   * data or a deleted entry.
   */
  sectionTextOf (entry, sessionId) {
    const id = typeof entry?.textId === 'string' && entry.textId !== '' ? entry.textId : null
    if (id !== null) {
      const fragment = this.fragmentById(id, sessionId)
      if (fragment !== undefined) return fragment.text
    }
    return typeof entry?.text === 'string' ? entry.text : ''
  }

  /** @returns {any[]} every template for one section name, in creation order. */
  fragmentsForKey (key, sessionId) {
    return this.libraryFor(sessionId).fragments.filter((fragment) => fragment.key === key)
  }

  /** @returns {any | undefined} */
  fragmentById (fragmentId, sessionId) {
    return this.libraryFor(sessionId).fragments.find((fragment) => fragment.id === fragmentId)
  }

  presets () {
    if (this.cache.presets === null) {
      const value = this._read(this.presetsPath(), emptyPresets())
      this.cache.presets = normalizePresets(value)
    }
    return this.cache.presets
  }

  savePresets (value) {
    const normalized = normalizePresets(value)
    this._write(this.presetsPath(), normalized)
    this.cache.presets = normalized
  }

  statePath (sessionId) {
    return path.join(this.sessionDir(sessionId), 'state.json')
  }

  /**
   * Whether this session already has formal Prompt Lab state. Used to decide
   * whether a not-yet-started window may open a draft: an older formal state
   * is never auto-converted into a draft (it stays a committed session).
   * @param {string} sessionId
   */
  hasFormalState (sessionId) {
    try {
      fs.accessSync(this.statePath(sessionId))
      return true
    } catch {
      return false
    }
  }

  /**
   * Cheap lifecycle check that deliberately does not populate the session
   * cache: subagents create many short-lived agents, and most of them have no
   * Prompt Lab state at all.
   * @param {string} sessionId
   * @returns {boolean}
   */
  isEnabled (sessionId) {
    try {
      const value = JSON.parse(fs.readFileSync(this.statePath(sessionId), 'utf8'))
      return value?.enabled === true
    } catch {
      return false
    }
  }

  state (sessionId) {
    const id = String(sessionId)
    const cached = this.cache.sessions.get(id)
    if (cached !== undefined) return cached
    const value = this._read(this.statePath(id), null)
    const state = value && typeof value === 'object' ? { ...emptySession(), ...value } : emptySession()
    if (!state.overrides || typeof state.overrides !== 'object' || Array.isArray(state.overrides)) state.overrides = {}
    if (!Array.isArray(state.extras)) state.extras = []
    normalizeCapabilityState(state)
    if (!Number.isFinite(state.firstSeenAt) || state.firstSeenAt === 0) {
      state.firstSeenAt = Number.isFinite(state.updatedAt) && state.updatedAt > 0 ? state.updatedAt : Date.now()
    }
    if (!Number.isFinite(state.lastSeenAt) || state.lastSeenAt === 0) state.lastSeenAt = state.firstSeenAt
    this.cache.sessions.set(id, state)
    return state
  }

  saveState (sessionId, state) {
    const id = String(sessionId)
    normalizeCapabilityState(state)
    state.updatedAt = Date.now()
    if (state.committed === undefined) state.committed = true
    if (!Number.isFinite(state.firstSeenAt) || state.firstSeenAt === 0) state.firstSeenAt = state.updatedAt
    state.lastSeenAt = state.updatedAt
    this._write(this.statePath(id), state)
    this.cache.sessions.set(id, state)
    return state
  }

  /**
   * One-time defensive cleanup for data written before tool/capability sections
   * became read-only. It removes references that can actually apply such a
   * section:
   *  - preset fragment ids for read-only keys,
   *  - session/draft overrides whose section name is read-only,
   *  - extras using a read-only section name,
   *  - draft-private read-only templates.
   * Library templates themselves are kept: they are inert without an override
   * and the user may still inspect/delete them from the library page.
   */
  sanitizeReadOnly () {
    const readOnlyIds = new Set(
      this.library().fragments.filter((fragment) => this.isReadOnly(fragment.key)).map((fragment) => fragment.id)
    )
    const changedPresets = new Set()
    let presetsChanged = 0
    const presets = JSON.parse(JSON.stringify(this.presets()))
    for (const preset of presets.presets) {
      if (!Array.isArray(preset.fragmentIds)) continue
      const next = preset.fragmentIds.filter((fragmentId) => !readOnlyIds.has(fragmentId))
      if (next.length !== preset.fragmentIds.length) {
        preset.fragmentIds = next
        preset.updatedAt = Date.now()
        changedPresets.add(preset.id)
        presetsChanged += 1
      }
    }
    if (presetsChanged > 0) this.savePresets(presets)

    let sessionsChanged = 0
    for (const id of this.listSessionIds()) {
      const state = this.state(id)
      let touched = false
      for (const key of Object.keys(state.overrides ?? {})) {
        if (this.isReadOnly(key)) {
          delete state.overrides[key]
          touched = true
        }
      }
      if (Array.isArray(state.extras)) {
        const next = state.extras.filter((extra) => !this.isReadOnly(extra?.name))
        if (next.length !== state.extras.length) {
          state.extras = next
          touched = true
        }
      }
      if (touched) {
        state.presetModified = true
        state.presetStats = null
        this.saveState(id, state)
        sessionsChanged += 1
      } else if (state.lastPreset?.id !== undefined && changedPresets.has(state.lastPreset.id)) {
        state.presetModified = true
        state.presetStats = null
        this.saveState(id, state)
        sessionsChanged += 1
      }
    }

    let draftsChanged = 0
    for (const id of this.listDraftIds()) {
      const draft = this.draft(id)
      if (draft === null) continue
      let touched = false
      for (const key of Object.keys(draft.state.overrides ?? {})) {
        if (this.isReadOnly(key)) {
          delete draft.state.overrides[key]
          touched = true
        }
      }
      if (Array.isArray(draft.state.extras)) {
        const next = draft.state.extras.filter((extra) => !this.isReadOnly(extra?.name))
        if (next.length !== draft.state.extras.length) {
          draft.state.extras = next
          touched = true
        }
      }
      const nextFragments = draft.fragments.filter((fragment) => !this.isReadOnly(fragment.key))
      if (nextFragments.length !== draft.fragments.length) {
        draft.fragments = nextFragments
        touched = true
      }
      if (touched) {
        this._write(this.draftPath(id), draft)
        this.cache.drafts.set(id, draft)
        draftsChanged += 1
      }
    }

    return { presets: presetsChanged, sessions: sessionsChanged, drafts: draftsChanged }
  }

  draftPath (sessionId) {
    if (!SESSION_ID.test(String(sessionId ?? ''))) throw new Error('invalid session id')
    const file = path.join(this.dir, 'drafts', `${String(sessionId)}.json`)
    assertNoSymlinkPath(this.dir, file)
    return file
  }

  /**
   * Read a draft session overlay. A draft is intentionally a separate file:
   * nothing about a not-yet-committed window may enter `sessions/` or the
   * global fragment library.
   * @param {string} sessionId
   * @returns {any | null}
   */
  draft (sessionId) {
    const id = String(sessionId)
    if (this.cache.drafts.has(id)) return this.cache.drafts.get(id)
    const raw = this._read(this.draftPath(id), null)
    if (raw === null || typeof raw !== 'object') {
      this.cache.drafts.set(id, null)
      return null
    }
    const sourceState = raw.state && typeof raw.state === 'object' ? raw.state : {}
    const state = { ...emptyDraft(id).state, ...sourceState }
    state.committed = false
    if (!state.overrides || typeof state.overrides !== 'object' || Array.isArray(state.overrides)) state.overrides = {}
    if (!Array.isArray(state.extras)) state.extras = []
    normalizeCapabilityState(state)
    const fragments = Array.isArray(raw.fragments)
      ? raw.fragments.filter((fragment) => fragment && typeof fragment === 'object').map(normalizeFragment)
      : []
    const draft = {
      ...raw,
      version: DRAFT_VERSION,
      sessionId: id,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
      lastSeenAt: Number.isFinite(raw.lastSeenAt) ? raw.lastSeenAt : (Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()),
      closedAt: Number.isFinite(raw.closedAt) ? raw.closedAt : 0,
      state,
      fragments
    }
    this.cache.drafts.set(id, draft)
    return draft
  }

  saveDraft (sessionId, value) {
    const id = String(sessionId)
    const source = value && typeof value === 'object' ? value : {}
    const now = Date.now()
    const draft = {
      ...source,
      version: DRAFT_VERSION,
      sessionId: id,
      createdAt: Number.isFinite(source.createdAt) && source.createdAt > 0 ? source.createdAt : now,
      updatedAt: now,
      lastSeenAt: now,
      closedAt: Number.isFinite(source.closedAt) ? source.closedAt : 0,
      state: {
        ...emptyDraft(id).state,
        ...(source.state && typeof source.state === 'object' ? source.state : {})
      },
      fragments: Array.isArray(source.fragments)
        ? source.fragments.filter((fragment) => fragment && typeof fragment === 'object').map(normalizeFragment)
        : []
    }
    draft.state.committed = false
    normalizeCapabilityState(draft.state)
    this._write(this.draftPath(id), draft)
    this.cache.drafts.set(id, draft)
    return draft
  }

  /**
   * Create the draft overlay for a session that has not started its first
   * turn. Existing drafts are returned untouched; a formal state file is never
   * overwritten by this path.
   * @param {string} sessionId
   * @param {object} [initialState]
   */
  ensureDraft (sessionId, initialState = {}) {
    const id = String(sessionId)
    const existing = this.draft(id)
    if (existing !== null) return existing
    const draft = emptyDraft(id)
    draft.state = { ...draft.state, ...initialState, committed: false }
    return this.saveDraft(id, draft)
  }

  /** Record that a draft's window was closed without changing its content. */
  touchDraft (sessionId, patch = {}) {
    const id = String(sessionId)
    const draft = this.draft(id)
    if (draft === null) return null
    const now = Date.now()
    Object.assign(draft, patch, { lastSeenAt: now })
    if (patch.closedAt === undefined) draft.closedAt = now
    this._write(this.draftPath(id), draft)
    this.cache.drafts.set(id, draft)
    return draft
  }

  /**
   * Pin templates that were saved before a capture existed to the official
   * baseline. A key missing from the baseline stays awaiting (and is never
   * registered unconditionally); it is pinned when the key appears.
   * Global templates referenced by a draft, legacy draft-private templates,
   * and already-committed templates with the `awaitingBaseline` marker are all
   * handled.
   * @param {string} sessionId
   * @param {{ name: string, hash: string, text: string }[]} rows
   */
  pinDraftBaselines (sessionId, rows) {
    const id = String(sessionId)
    if (!Array.isArray(rows) || rows.length === 0) return 0
    const byName = new Map(rows.map((row) => [row.name, row]))
    let changed = 0
    const draft = this.draft(id)
    if (draft !== null) {
      for (const fragment of draft.fragments) {
        const awaiting = fragment.awaitingBaseline === true || fragment.baseHash === null
        if (!awaiting) continue
        const row = byName.get(fragment.key)
        if (row === undefined) {
          // The key is not in the baseline yet. Keep it explicitly pending so
          // `baseHash: null` can never be treated as an unconditional override.
          if (fragment.awaitingBaseline !== true) {
            fragment.awaitingBaseline = true
            changed += 1
          }
          continue
        }
        fragment.baseHash = row.hash
        fragment.baseText = String(row.text ?? '').slice(0, MAX_DRAFT_TEXT)
        delete fragment.awaitingBaseline
        changed += 1
      }
      if (changed > 0) {
        this._write(this.draftPath(id), draft)
        this.cache.drafts.set(id, draft)
      }
      // New templates live in the GLOBAL library even when the mapping is a
      // draft (the blank window must not take a library entry with it). Pin
      // those global templates too, so a null base hash never applies
      // unconditionally.
      const library = this.library()
      let globalChanged = 0
      for (const [key, fragmentId] of Object.entries(draft.state.overrides ?? {})) {
        const fragment = library.fragments.find((entry) => entry.id === fragmentId)
        if (fragment === undefined) continue
        if (fragment.awaitingBaseline !== true && fragment.baseHash !== null) continue
        const row = byName.get(key)
        if (row === undefined) {
          if (fragment.awaitingBaseline !== true) {
            fragment.awaitingBaseline = true
            globalChanged += 1
          }
          continue
        }
        fragment.baseHash = row.hash
        fragment.baseText = String(row.text ?? '').slice(0, MAX_DRAFT_TEXT)
        delete fragment.awaitingBaseline
        globalChanged += 1
      }
      if (globalChanged > 0) this.saveLibrary(library)
      return changed + globalChanged
    }

    const state = this.state(id)
    const library = this.library()
    for (const [key, fragmentId] of Object.entries(state.overrides ?? {})) {
      const fragment = library.fragments.find((entry) => entry.id === fragmentId)
      if (fragment === undefined || fragment.awaitingBaseline !== true) continue
      const row = byName.get(key)
      if (row === undefined) continue
      fragment.baseHash = row.hash
      fragment.baseText = String(row.text ?? '').slice(0, MAX_DRAFT_TEXT)
      delete fragment.awaitingBaseline
      changed += 1
    }
    if (changed > 0) this.saveLibrary(library)
    return changed
  }

  deleteDraft (sessionId) {
    const id = String(sessionId)
    try {
      fs.unlinkSync(this.draftPath(id))
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`cannot delete draft: ${error?.message ?? error}`)
    }
    this.cache.drafts.set(id, null)
  }

  listDraftIds () {
    try {
      assertNoSymlinkPath(this.dir, path.join(this.dir, 'drafts'))
      return fs.readdirSync(path.join(this.dir, 'drafts'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && SESSION_ID.test(entry.name.slice(0, -5)))
        .map((entry) => entry.name.slice(0, -5))
    } catch {
      return []
    }
  }

  hasDraft (sessionId) {
    return this.draft(sessionId) !== null
  }

  isDraft (sessionId) {
    return this.hasDraft(sessionId)
  }

  /** Draft state when one exists, otherwise the formal session state. */
  stateFor (sessionId) {
    const draft = this.draft(sessionId)
    return draft === null ? this.state(sessionId) : draft.state
  }

  /** Global fragment library plus the current draft's private templates. */
  libraryFor (sessionId) {
    const draft = this.draft(sessionId)
    if (draft === null) return this.library()
    return {
      version: LIBRARY_VERSION,
      fragments: [...this.library().fragments, ...draft.fragments]
    }
  }

  templatesFor (sessionId, key) {
    return this.libraryFor(sessionId).fragments.filter((fragment) => fragment.key === key)
  }

  isEnabledFor (sessionId) {
    const draft = this.draft(sessionId)
    return draft === null ? this.isEnabled(sessionId) : draft.state.enabled === true
  }

  committed (sessionId) {
    return this.draft(sessionId) === null
  }

  /**
   * Merge a draft into the formal session, then remove it.
   *
   * New templates are already global when a draft saves them. Legacy drafts
   * may still carry private templates; only those actually referenced by
   * `state.overrides` are merged (deduplicated by `key + mode + text`). The
   * formal state is written before the draft disappears; the first automatic
   * backup is best-effort and never blocks the commit.
   *
   * @param {string} sessionId
   * @param {{ captureOf?: (key: string) => ({ officialHash: string, officialText?: string } | null) }} [options]
   */
  commitDraft (sessionId, options = {}) {
    const id = String(sessionId)
    const draft = this.draft(id)
    if (draft === null) return { committed: false, reason: 'no-draft' }
    const now = Date.now()
    const draftById = new Map(draft.fragments.map((fragment) => [fragment.id, fragment]))
    const global = {
      ...this.library(),
      fragments: [...this.library().fragments]
    }
    const overrides = {}
    let created = 0
    let mapped = 0
    let pending = 0
    let libraryChanged = 0

    for (const [key, fragmentId] of Object.entries(draft.state.overrides ?? {})) {
      if (this.isReadOnly(key) || typeof fragmentId !== 'string') continue
      const privateFragment = draftById.get(fragmentId)
      if (privateFragment === undefined) {
        // A draft may legitimately map a global template selected from the
        // library. Keep that mapping as-is, but never keep a key mismatch.
        const globalFragment = global.fragments.find((fragment) => fragment.id === fragmentId)
        if (globalFragment !== undefined && globalFragment.key === key) {
          overrides[key] = fragmentId
          mapped += 1
          if (globalFragment.awaitingBaseline === true || globalFragment.baseHash === null) {
            const capture = typeof options.captureOf === 'function' ? options.captureOf(key) : null
            if (capture !== null && typeof capture?.officialHash === 'string') {
              globalFragment.baseHash = capture.officialHash
              globalFragment.baseText = String(capture.officialText ?? '').slice(0, MAX_DRAFT_TEXT)
              delete globalFragment.awaitingBaseline
              libraryChanged += 1
            } else if (globalFragment.awaitingBaseline !== true) {
              globalFragment.awaitingBaseline = true
              libraryChanged += 1
            }
          }
        }
        continue
      }
      if (privateFragment.key !== key) continue
      const exact = global.fragments.find((fragment) =>
        fragment.key === privateFragment.key &&
        fragment.mode === privateFragment.mode &&
        fragment.text === privateFragment.text)
      if (exact !== undefined) {
        overrides[key] = exact.id
        mapped += 1
        continue
      }

      let baseHash = privateFragment.baseHash ?? null
      let baseText = typeof privateFragment.baseText === 'string' ? privateFragment.baseText : ''
      let awaitingBaseline = privateFragment.awaitingBaseline === true || baseHash === null
      if (awaitingBaseline) {
        const capture = typeof options.captureOf === 'function' ? options.captureOf(key) : null
        if (capture !== null && typeof capture?.officialHash === 'string') {
          baseHash = capture.officialHash
          baseText = String(capture.officialText ?? '').slice(0, MAX_DRAFT_TEXT)
          awaitingBaseline = false
        }
      }
      if (awaitingBaseline) pending += 1
      const fragmentIdNew = `frag_${randomBytes(6).toString('hex')}`
      const fragment = {
        ...privateFragment,
        id: fragmentIdNew,
        baseHash,
        baseText,
        createdAt: Number.isFinite(privateFragment.createdAt) ? privateFragment.createdAt : now,
        updatedAt: now
      }
      if (awaitingBaseline) fragment.awaitingBaseline = true
      else delete fragment.awaitingBaseline
      global.fragments.push(fragment)
      overrides[key] = fragmentIdNew
      created += 1
    }

    if (created > 0 || libraryChanged > 0) this.saveLibrary(global)

    const extras = (Array.isArray(draft.state.extras) ? draft.state.extras : [])
      .filter((extra) => extra && !this.isReadOnly(extra.name))
    const state = {
      ...emptySession(),
      ...draft.state,
      overrides,
      extras,
      committed: true,
      lastCapture: null,
      updatedAt: now
    }
    this.saveState(id, state)

    let backup = null
    try {
      backup = this.backup(id, '首次对话提交', 'auto')
    } catch (error) {
      this.warn(`cannot write the first draft backup: ${error?.message ?? error}`)
    }
    this.deleteDraft(id)
    return { committed: true, overrides, created, mapped, pending, backup }
  }

  /**
   * Remove drafts whose DSH session no longer exists, plus drafts that have
   * not been seen for the TTL. Unknown liveness is not treated as missing;
   * only the TTL can remove it. Archived sessions keep their draft until TTL,
   * matching the "archived is recoverable, not gone" rule.
   * @param {(ids: string[]) => Promise<Map<string, { status: string }>>} [livenessOf]
   * @param {{ ttl?: number, now?: number }} [options]
   */
  async gcDrafts (livenessOf, options = {}) {
    const ids = this.listDraftIds()
    const now = Number.isFinite(options.now) ? options.now : Date.now()
    const ttl = Number.isFinite(options.ttl) ? options.ttl : DRAFT_TTL_MS
    let statuses = new Map()
    if (typeof livenessOf === 'function' && ids.length > 0) {
      try {
        const value = await livenessOf(ids)
        if (value instanceof Map) statuses = value
      } catch (error) {
        this.warn(`cannot classify drafts for cleanup: ${error?.message ?? error}`)
      }
    }
    const removed = []
    const kept = []
    for (const sessionId of ids) {
      const draft = this.draft(sessionId)
      if (draft === null) continue
      const seen = Math.max(
        Number(draft.lastSeenAt) || 0,
        Number(draft.updatedAt) || 0,
        Number(draft.createdAt) || 0
      )
      const expired = seen > 0 && now - seen > ttl
      const status = statuses.get(sessionId)?.status ?? 'unknown'
      if (expired || status === 'missing') {
        this.deleteDraft(sessionId)
        removed.push(sessionId)
      } else {
        kept.push(sessionId)
      }
    }
    return { removed, kept }
  }

  /**
   * P6 one-time link pass: old extras/transients stored inline text only. Turn
   * each distinct (name, text) pair into an `insert` text entry and keep the
   * session section as a reference. Prefill fixed text is linked the same way
   * to `messages.json`. Idempotent: a linked entry is only re-synced when its
   * library text changed.
   */
  migrateInlineSections () {
    const library = normalizeLibrary(this.library())
    const messages = normalizeMessageLibrary(this.messageLibrary())
    let libraryChanged = false
    let messagesChanged = false
    const sectionEntryFor = (name, value, activation) => {
      if (typeof name !== 'string' || name === '' || value.trim() === '') return null
      const exact = library.fragments.find((fragment) =>
        fragment.target === 'insert' &&
        fragment.key === name &&
        fragment.mode === 'replace' &&
        fragment.text === value)
      if (exact !== undefined) return exact.id
      const now = Date.now()
      const entry = {
        id: `frag_${randomBytes(6).toString('hex')}`,
        key: name,
        label: nextDefaultLabel(library.fragments),
        mode: 'replace',
        target: 'insert',
        activation: normalizeActivation(activation, 'once'),
        text: value,
        baseHash: null,
        baseText: '',
        createdAt: now,
        updatedAt: now
      }
      library.fragments.push(entry)
      libraryChanged = true
      return entry.id
    }
    const messageEntryFor = (value) => {
      const exact = messages.entries.find((entry) => entry.text === value)
      if (exact !== undefined) return exact.id
      const now = Date.now()
      const entry = {
        id: `msg_${randomBytes(6).toString('hex')}`,
        label: nextDefaultLabel(messages.entries),
        text: value,
        createdAt: now,
        updatedAt: now
      }
      messages.entries.push(entry)
      messagesChanged = true
      return entry.id
    }
    const patch = (state) => {
      let touched = false
      const lists = [
        Array.isArray(state.extras) ? state.extras : [],
        Array.isArray(state.transientSections) ? state.transientSections : []
      ]
      for (const list of lists) {
        for (const entry of list) {
          if (!entry || typeof entry.name !== 'string' || this.isReadOnly(entry.name)) continue
          const value = typeof entry.text === 'string' ? entry.text : ''
          const linked = typeof entry.textId === 'string'
            ? library.fragments.find((fragment) => fragment.id === entry.textId && fragment.target === 'insert')
            : undefined
          if (linked !== undefined) {
            if (linked.text !== value) {
              entry.text = linked.text
              touched = true
            }
            continue
          }
          if (entry.textId) {
            entry.textId = null
            touched = true
          }
          if (value.trim() === '') continue
          const textId = sectionEntryFor(entry.name, value, entry.activation)
          if (textId !== null) {
            entry.textId = textId
            touched = true
          }
        }
      }
      const auto = state.autoAssistant
      if (auto && typeof auto === 'object') {
        const value = typeof auto.text === 'string' ? auto.text : ''
        const linked = typeof auto.textId === 'string'
          ? messages.entries.find((entry) => entry.id === auto.textId)
          : undefined
        if (linked !== undefined) {
          if (linked.text !== value) {
            auto.text = linked.text
            touched = true
          }
        } else {
          if (auto.textId) {
            auto.textId = null
            touched = true
          }
          if (value.trim() !== '') {
            auto.textId = messageEntryFor(value)
            touched = true
          }
        }
      }
      return touched
    }

    const states = []
    for (const id of this.listSessionIds()) {
      const state = this.state(id)
      if (patch(state)) states.push({ id, draft: false })
    }
    for (const id of this.listDraftIds()) {
      const draft = this.draft(id)
      if (draft !== null && patch(draft.state)) states.push({ id, draft: true })
    }

    if (libraryChanged) this.saveLibrary(library)
    if (messagesChanged) this.saveMessageLibrary(messages)
    for (const item of states) {
      if (item.draft) {
        const draft = this.draft(item.id)
        if (draft !== null) this.saveDraft(item.id, draft)
      } else {
        this.saveState(item.id, this.state(item.id))
      }
    }
    return {
      sessions: states.filter((item) => !item.draft).length,
      drafts: states.filter((item) => item.draft).length,
      library: libraryChanged,
      messages: messagesChanged
    }
  }

  /**
   * Delete all Prompt Lab-owned data under this data dir: section/message
   * libraries, presets, session state/backups, drafts, pending markers and the
   * generated warning file. The Store deliberately leaves `config.json` alone;
   * the Host full-reset path removes it and resets settings.
   */
  wipeAll () {
    if (this.dir === path.parse(this.dir).root) throw new Error('拒绝清空磁盘根目录')
    // Never delete generic top-level names from a directory this plugin did not
    // initialize: a user-chosen dataDir may be an existing project folder.
    if (!isOwnedDataDir(this.dir)) {
      throw new Error('拒绝清空：该目录没有 Prompt Lab 所有权标记')
    }
    const removed = []
    for (const name of ['library', 'sessions', 'drafts', 'pending']) {
      const target = path.join(this.dir, name)
      if (!fs.existsSync(target)) continue
      // Do not recursively delete through a junction/symlink to an unrelated
      // directory.
      assertNoSymlinkPath(this.dir, target)
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(name)
    }
    let warningRemoved = false
    const warning = path.join(this.dir, WORKSPACE_WARNING_FILE)
    if (fs.existsSync(warning)) {
      fs.rmSync(warning, { force: true })
      warningRemoved = true
    }
    let ownerMarkerRemoved = false
    const marker = path.join(this.dir, OWNER_MARKER_FILE)
    if (fs.existsSync(marker)) {
      fs.rmSync(marker, { force: true })
      ownerMarkerRemoved = true
    }
    this.cache.library = null
    this.cache.messages = null
    this.cache.presets = null
    this.cache.sessions.clear()
    this.cache.drafts.clear()
    this.cache.locked.clear()
    this.ensure()
    return { dataDir: this.dir, removed, warningRemoved, ownerMarkerRemoved }
  }

  /** Snapshot the session's prompt/capability config before a mutation. */
  backup (sessionId, label, kind) {
    const id = String(sessionId)
    const category = kind === 'manual' ? 'manual' : 'auto'
    const at = new Date()
    const stamp = at.toISOString().replace(/[:.]/g, '-')
    const name = `${stamp}-${category}-${randomBytes(3).toString('hex')}.json`
    const file = path.join(this.sessionDir(id), 'backups', name)
    const state = this.state(id)
    const byId = new Map(this.library().fragments.map((fragment) => [fragment.id, fragment]))
    const fragments = []
    const seen = new Set()
    const overrides = {}
    for (const [key, fragmentId] of Object.entries(state.overrides ?? {})) {
      if (this.isReadOnly(key)) continue
      overrides[key] = fragmentId
      if (seen.has(fragmentId)) continue
      seen.add(fragmentId)
      const fragment = byId.get(fragmentId)
      if (fragment === undefined) continue
      fragments.push({
        id: fragment.id,
        key: fragment.key,
        label: fragment.label ?? '',
        mode: fragment.mode === 'empty' ? 'empty' : 'replace',
        target: 'override',
        activation: 'persistent',
        text: typeof fragment.text === 'string' ? fragment.text : '',
        baseHash: fragment.baseHash ?? null,
        baseText: fragment.baseText ?? '',
        ...(fragment.awaitingBaseline === true ? { awaitingBaseline: true } : {})
      })
    }
    const textIds = new Set()
    const extras = Array.isArray(state.extras)
      ? state.extras
        .filter((extra) => extra && !this.isReadOnly(extra.name))
        .map((extra) => {
          const value = this.sectionTextOf(extra, id)
          if (typeof extra.textId === 'string' && extra.textId !== '') textIds.add(extra.textId)
          return {
            name: extra.name,
            anchor: extra.anchor ?? '__end__',
            order: Number(extra.order) || 0,
            textId: typeof extra.textId === 'string' ? extra.textId : null,
            text: value
          }
        })
      : []
    const transientSections = Array.isArray(state.transientSections)
      ? state.transientSections
        .filter((entry) => entry && !this.isReadOnly(entry.name))
        .map((entry) => {
          const value = this.sectionTextOf(entry, id)
          if (typeof entry.textId === 'string' && entry.textId !== '') textIds.add(entry.textId)
          return {
            name: entry.name,
            anchor: entry.anchor ?? '__end__',
            order: Number(entry.order) || 0,
            activation: 'once',
            enabled: entry.enabled !== false,
            textId: typeof entry.textId === 'string' ? entry.textId : null,
            text: value
          }
        })
      : []
    const sectionTexts = []
    for (const textId of textIds) {
      const fragment = byId.get(textId)
      if (fragment === undefined || fragment.target !== 'insert') continue
      sectionTexts.push({
        id: fragment.id,
        key: fragment.key,
        label: fragment.label ?? '',
        activation: normalizeActivation(fragment.activation, 'once'),
        text: typeof fragment.text === 'string' ? fragment.text : '',
        createdAt: fragment.createdAt ?? 0,
        updatedAt: fragment.updatedAt ?? 0
      })
    }
    this._write(file, {
      version: BACKUP_VERSION,
      at: at.toISOString(),
      kind: category,
      label: String(label ?? 'edit'),
      session: {
        prompt: { overrides, extras, transientSections },
        capabilities: { toolPolicy: normalizeToolPolicy(state.toolPolicy) }
      },
      fragments,
      sectionTexts
    })
    this._prune(id)
    return { file: name, kind: category, at: at.toISOString(), label: String(label ?? 'edit') }
  }

  listBackups (sessionId) {
    const dir = path.join(this.sessionDir(sessionId), 'backups')
    let names = []
    try {
      assertNoSymlinkPath(this.dir, dir)
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`cannot list backups: ${error?.message ?? error}`)
      return []
    }
    const rows = []
    for (const name of names.sort().reverse()) {
      const value = this._read(path.join(dir, name), null)
      if (value?.version !== BACKUP_VERSION || value?.session?.prompt === undefined) continue
      const kind = value?.kind === 'manual' || name.includes('-manual-') ? 'manual' : 'auto'
      rows.push({
        file: name,
        at: value?.at ?? null,
        kind,
        label: value?.label ?? '',
        version: BACKUP_VERSION,
        overrides: Object.keys(value.session.prompt.overrides ?? {}).length,
        extras: Array.isArray(value.session.prompt.extras) ? value.session.prompt.extras.length : 0,
        transient: Array.isArray(value.session.prompt.transientSections)
          ? value.session.prompt.transientSections.length
          : 0,
        toolDeny: Array.isArray(value.session.capabilities?.toolPolicy?.deny)
          ? value.session.capabilities.toolPolicy.deny.length
          : 0
      })
    }
    return rows
  }

  readBackup (sessionId, file) {
    if (!/^[A-Za-z0-9._-]+\.json$/.test(String(file ?? ''))) throw new Error('invalid backup name')
    const target = path.join(this.sessionDir(sessionId), 'backups', String(file))
    const value = this._read(target, null)
    if (value === null) throw new Error('backup not found')
    return value
  }

  /** Prune automatic and manual backups separately so manual ones survive. */
  _prune (sessionId) {
    const dir = path.join(this.sessionDir(sessionId), 'backups')
    let names = []
    try {
      assertNoSymlinkPath(this.dir, dir)
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    } catch {
      return
    }
    const limits = this.limits()
    const buckets = { auto: [], manual: [] }
    for (const name of names) {
      const value = this._read(path.join(dir, name), null)
      const kind = value?.kind === 'manual' || name.includes('-manual-') ? 'manual' : 'auto'
      buckets[kind].push(name)
    }
    for (const [kind, list] of Object.entries(buckets)) {
      const limit = kind === 'manual'
        ? (Number(limits.manualBackupLimit) || 5)
        : (Number(limits.autoBackupLimit) || 20)
      while (list.length > limit) {
        const oldest = list.shift()
        try {
          const target = path.join(dir, oldest)
          assertNoSymlinkPath(this.dir, target)
          fs.unlinkSync(target)
        } catch {
          /* best effort */
        }
      }
    }
  }
}
