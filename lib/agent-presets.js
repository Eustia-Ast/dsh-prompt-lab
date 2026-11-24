/**
 * preset-editor: Agent presets owned by Prompt Lab.
 *
 * A DSH Agent preset is an ordinary loader row whose plugin is
 * `@deepseek-ai/dsh-agent-preset`; that plugin is a thin wrapper around
 * `ctx.agentPresets.register(definition)`. Prompt Lab declares its own through
 * the same public service, so a preset costs no bundle install and no profile
 * patch: the definitions live in `<dataDir>/library/agent-presets.json` and are
 * re-registered on every Host start.
 *
 * Hard rules this module encodes, from the registry source:
 *  - `register()` rejects only an id that is ALREADY on the roster, and Host
 *    activation order decides who wins. A plugin must therefore refuse shipped
 *    ids by policy, never by probe: an early row can silently take `standard`
 *    and replace it with an empty composition.
 *  - A definition whose rows fail to mount still registers; it stays on the
 *    roster and reports `broken`. `register()` does not throw for that, so the
 *    roster read is what tells the panel whether a preset works.
 *  - Rows resolve from the registry's own resolution base (the DSH
 *    installation), so only packages shipped with dsh belong here.
 *
 * The prompt half comes from Prompt Lab's fragment library: selected fragments
 * are materialized into a `dsh-persona` prefix at save time (the panel keeps the
 * fragment ids so it can re-sync), which is why the editor never has to write
 * YAML or expose arbitrary plugin rows.
 */

import fs from 'node:fs'
import path from 'node:path'

export const AGENT_PRESET_VERSION = 1
/** Definitions kept per profile. Every one mounts a subtree, so keep it small. */
export const AGENT_PRESET_LIMIT = 20
export const AGENT_PRESET_NAME_LIMIT = 48
export const AGENT_PRESET_DESCRIPTION_LIMIT = 300
// Complete prompts are whole documents; 20k cut off long jailbreak-style texts.
export const AGENT_PRESET_TEXT_LIMIT = 50_000
/** Row cap for a preset copied from another declaration. */
export const AGENT_PRESET_ROW_LIMIT = 64
/** Serialized config cap per copied row; a complete persona carries the text. */
export const AGENT_PRESET_CONFIG_LIMIT = 320 * 1024
/** Row fields preserved when a preset is copied; everything else is dropped. */
const ROW_KEYS = ['name', 'id', 'config', 'disabled', 'group', 'isolate', 'inject', 'intercept']
/** Ids owned by the shipped bundles; taking one can replace a built-in preset. */
export const RESERVED_IDS = ['standard', 'ptc', 'minimal', 'cordis']
const ID_PATTERN = /^[a-z][a-z0-9-]{1,32}$/

// Row facts come from scripts/build-row-schemas.mjs, generated from the
// installed DSH (fields, tools, official default configs). A missing table only
// degrades the editor to plain rows; it never blocks registration.
const SCHEMA_URL = new URL('./row-schemas.json', import.meta.url)
function readSchemas () {
  try { return JSON.parse(fs.readFileSync(SCHEMA_URL, 'utf8')) } catch { return null }
}
const ROW_SCHEMAS = readSchemas()

/** Rows the editor offers for a new preset, grouped for the picker. */
const ROW_META = [
  { group: '基础', name: '@deepseek-ai/dsh-agent-instructions', label: '指令文件', note: 'AGENTS/CLAUDE 指令注入' },
  { group: '基础', name: '@deepseek-ai/dsh-time-context', label: '时间上下文', note: '当前时间与时区' },
  { group: 'shell', name: '@deepseek-ai/dsh-tool-bash', label: 'Bash shell', note: 'bash 命令执行', platform: 'posix' },
  { group: 'shell', name: '@deepseek-ai/dsh-tool-pwsh', label: 'PowerShell', note: 'pwsh 命令执行', platform: 'win32' },
  { group: '文件', name: '@deepseek-ai/dsh-tool-fs', label: '文件读写', note: '读/写/编辑/补丁' },
  { group: '文件', name: '@deepseek-ai/dsh-tool-fs-search', label: '文件搜索', note: 'glob / grep' },
  { group: '任务', name: '@deepseek-ai/dsh-tool-todo', label: '任务清单', note: 'todo 计划工具' },
  { group: '任务', name: '@deepseek-ai/dsh-tool-jobs', label: '后台任务', note: 'job 输出与等待' },
  { group: '任务', name: '@deepseek-ai/dsh-tool-goal', label: '目标循环', note: '持久目标' },
  { group: '任务', name: '@deepseek-ai/dsh-tool-schedule', label: '定时任务', note: 'schedule_* 工具' },
  { group: '任务', name: '@deepseek-ai/dsh-command-goal', label: '目标命令', note: '/goal 命令' },
  { group: '技能', name: '@deepseek-ai/dsh-tool-skill', label: '技能加载', note: '按需加载技能' },
  { group: '交互', name: '@deepseek-ai/dsh-tool-present', label: '交付物展示', note: 'present 工具' },
  { group: '交互', name: '@deepseek-ai/dsh-tool-web', label: '网页', note: '搜索 / 抓取' },
  { group: '交互', name: '@deepseek-ai/dsh-tool-ask-user', label: '提问', note: 'ask_user_question' },
  { group: '交互', name: '@deepseek-ai/dsh-tool-office', label: 'Office 文档', note: '渲染 / 转换 / 重算' }
]

/** Old single-row entries kept so presets saved before the group templates load. */
const LEGACY_ROWS = [
  { name: '@deepseek-ai/dsh-tool-subagent', label: '子代理（旧）', note: '已改为组模板，仅为兼容旧预设保留' },
  { name: '@deepseek-ai/dsh-compaction-basic', label: '历史压缩（旧）', note: '已改为组模板，仅为兼容旧预设保留' },
  { name: '@deepseek-ai/dsh-command-compact', label: '压缩命令（旧）', note: '已改为组模板，仅为兼容旧预设保留' }
]

const shortId = (name) => name.split('/').pop()

/** Rows the picker may add; legacy entries are resolved but not offered. */
export const ROW_CATALOG = [
  ...ROW_META.map((entry) => {
    const schema = ROW_SCHEMAS?.rows?.[entry.name] ?? null
    return {
      rowId: shortId(entry.name),
      ...entry,
      kind: 'row',
      fields: schema?.fields ?? [],
      tools: schema?.tools ?? [],
      config: schema?.defaultConfig ?? {}
    }
  }),
  ...LEGACY_ROWS.map((entry) => ({
    rowId: shortId(entry.name),
    group: '兼容',
    kind: 'legacy',
    fields: [],
    tools: [],
    config: {},
    ...entry
  }))
]

/** Group templates copied from shipped presets (isolate realms included). */
const TEMPLATE_LABELS = { planning: '计划模式', compaction: '压缩', delegation: '委托（子代理）', 'persistent-shell': '持久 shell' }
function templateRowsForPlatform (template) {
  if (template.id !== 'persistent-shell') return template.rows
  const windows = process.platform === 'win32'
  return template.rows.filter((row) => {
    const dialect = row.config?.shellDialect
    if (row.name.includes('pwsh') || dialect === 'pwsh') return windows
    if (row.name.includes('bash') || dialect === 'bash') return !windows
    return true
  })
}
const TEMPLATE_BY_ID = new Map((ROW_SCHEMAS?.templates ?? []).map((template) => [template.id, template]))
export const ROW_TEMPLATES = (ROW_SCHEMAS?.templates ?? []).map((template) => ({
  id: template.id,
  label: TEMPLATE_LABELS[template.id] ?? template.id,
  isolate: template.isolate ?? null,
  rows: templateRowsForPlatform(template)
}))

/**
 * Provider names a template depends on: the `dsh-tool-subagent` rows declare
 * one, and the Host registers exactly those through the `subagents` service.
 */
function templateProviders (template) {
  const names = new Set()
  for (const row of template.rows ?? []) {
    if (!String(row.name ?? '').endsWith('dsh-tool-subagent')) continue
    const provider = row.config?.provider
    if (typeof provider === 'string' && provider !== '') names.add(provider)
  }
  return [...names]
}

/** Rows that exist only as part of a copied preset. */
const COPY_ONLY = [
  '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-plugin-manager/tools',
  '@deepseek-ai/dsh-plugin-market/tools',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tool-executor-ptc'
]

/**
 * Files that carry the installed DSH version. The desktop Host is the Electron
 * binary in node mode, so `app.asar` paths are readable and `resourcesPath` is
 * set; the executable fallback covers a Host started some other way.
 */
function installedVersionFiles () {
  const roots = []
  if (process.resourcesPath !== undefined) roots.push(process.resourcesPath)
  const executable = process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? process.execPath
  if (typeof executable === 'string' && executable.length > 0) roots.push(path.join(path.dirname(executable), 'resources'))
  return roots.map((root) => path.join(root, 'app.asar', 'dsh', 'package.json'))
}

/** Installed dsh version, for the stale-table banner. */
function currentDshVersion () {
  for (const file of installedVersionFiles()) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null } catch { /* next */ }
  }
  return null
}
const CURRENT_DSH = currentDshVersion()
export const SCHEMA_STATUS = {
  table: ROW_SCHEMAS?.dsh ?? null,
  current: CURRENT_DSH,
  stale: ROW_SCHEMAS?.dsh != null && CURRENT_DSH != null && ROW_SCHEMAS.dsh !== CURRENT_DSH,
  generatedAt: ROW_SCHEMAS?.generatedAt ?? null
}

const CATALOG_BY_NAME = new Map(ROW_CATALOG.map((entry) => [entry.name, entry]))


function emptyDoc () {
  return { version: AGENT_PRESET_VERSION, presets: [] }
}

function clip (value, limit) {
  const text = typeof value === 'string' ? value : ''
  return text.length > limit ? text.slice(0, limit) : text
}

function normalizeOrder (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(9999, Math.trunc(number))) : fallback
}

/**
 * Keep only row fields the Loader understands. Used for presets copied from a
 * declaration: their rows may name packages outside the catalog, and `disabled`
 * may carry a `{ __jsExpr }` placeholder that must survive as an object.
 *
 * Lenient mode (reading the file) drops a malformed config; strict mode (saving
 * the panel) rejects it with the row number so the user can fix it.
 */
function sanitizePlugins (value, options = {}) {
  if (!Array.isArray(value)) return []
  const strict = options.strict === true
  return value
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row) && typeof row.name === 'string' && row.name !== '')
    .slice(0, AGENT_PRESET_ROW_LIMIT)
    .map((row, index) => {
      const next = {}
      for (const key of ROW_KEYS) {
        if (row[key] === undefined) continue
        if (key === 'config') {
          const config = row.config
          if (config !== null && typeof config === 'object') {
            const size = JSON.stringify(config).length
            if (size > AGENT_PRESET_CONFIG_LIMIT) {
              if (strict) throw new Error(`第 ${index + 1} 行的 config 超过 ${AGENT_PRESET_CONFIG_LIMIT} 字节上限`)
              continue
            }
            next.config = structuredClone(config)
          } else if (config !== null && strict) {
            throw new Error(`第 ${index + 1} 行的 config 必须是 JSON 对象或数组`)
          }
          continue
        }
        next[key] = structuredClone(row[key])
      }
      return next
    })
}

/**
 * Required config keys for raw rows, from the generated table. Catalog rows get
 * their official defaults at build time; copied rows carry the source config,
 * so a hand-edited copy could drop a required key and register `broken` later.
 */
function assertRequiredConfig (plugins) {
  const visit = (rows, prefix) => {
    rows.forEach((row, index) => {
      if (row.group === true && Array.isArray(row.config)) {
        visit(row.config, `${prefix}第 ${index + 1} 行组内`)
        return
      }
      const schema = ROW_SCHEMAS?.rows?.[row.name]
      if (schema === undefined || !Array.isArray(schema.fields)) return
      for (const field of schema.fields) {
        if (field.required !== true) continue
        if (row.config !== undefined && Object.prototype.hasOwnProperty.call(row.config, field.key)) continue
        throw new Error(`${prefix}第 ${index + 1} 行 ${row.name} 缺少必填项 ${field.key}`)
      }
    })
  }
  visit(plugins, '')
}

/**
 * Normalize one stored definition, dropping rows outside the catalog and any
 * field the panel never writes. A malformed entry is discarded rather than
 * repaired into something the user did not choose.
 */
function normalizeStored (entry) {
  if (!entry || typeof entry !== 'object') return null
  const id = typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : ''
  if (!ID_PATTERN.test(id) || RESERVED_IDS.includes(id)) return null
  const rows = Array.isArray(entry.rows)
    ? entry.rows.filter((name) => CATALOG_BY_NAME.has(name))
    : []
  const prompt = entry.prompt && typeof entry.prompt === 'object' ? entry.prompt : {}
  return {
    id,
    name: clip(typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id, AGENT_PRESET_NAME_LIMIT),
    description: clip(typeof entry.description === 'string' ? entry.description.trim() : '', AGENT_PRESET_DESCRIPTION_LIMIT),
    order: normalizeOrder(entry.order, 100),
    enabled: entry.enabled !== false,
    // A complete preset replaces the whole system prompt with the persona row;
    // copies carry that flag inside the persona row instead.
    complete: entry.complete === true,
    rows,
    // Rows copied from another declaration; when present they replace the
    // catalog selection and the persona prefix entirely.
    plugins: sanitizePlugins(entry.plugins),
    templates: Array.isArray(entry.templates) ? entry.templates.filter((value) => typeof value === "string" && TEMPLATE_BY_ID.has(value)) : [],
    rowConfigs: normalizeRowConfigs(entry.rowConfigs),
    prompt: {
      fragmentIds: Array.isArray(prompt.fragmentIds) ? prompt.fragmentIds.filter((value) => typeof value === 'string') : [],
      text: clip(typeof prompt.text === 'string' ? prompt.text : '', AGENT_PRESET_TEXT_LIMIT),
      prefix: clip(typeof prompt.prefix === 'string' ? prompt.prefix : '', AGENT_PRESET_TEXT_LIMIT),
      suffix: clip(typeof prompt.suffix === 'string' ? prompt.suffix : '', AGENT_PRESET_TEXT_LIMIT)
    },
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now()
  }
}

function normalizeDoc (raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const presets = Array.isArray(source.presets)
    ? source.presets.map(normalizeStored).filter((entry) => entry !== null)
    : []
  return { ...source, version: AGENT_PRESET_VERSION, presets }
}

/** Row-level config overrides from the panel: catalog names only, plain objects. */
function normalizeRowConfigs (value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  const next = {}
  for (const [name, config] of Object.entries(value)) {
    if (typeof name !== "string" || !CATALOG_BY_NAME.has(name)) continue
    if (config === null || typeof config !== "object" || Array.isArray(config)) continue
    if (JSON.stringify(config).length > AGENT_PRESET_CONFIG_LIMIT) continue
    next[name] = structuredClone(config)
  }
  return next
}

/** Build the definition handed to `agentPresets.register()`. */
export function buildDefinition (preset) {
  const declared = Array.isArray(preset.plugins) ? preset.plugins : []
  if (declared.length > 0) {
    // Copied rows are the complete composition: no persona injection, no
    // catalog expansion, and `{ __jsExpr }` placeholders stay untouched.
    return {
      id: preset.id,
      ...(preset.name !== '' ? { name: preset.name } : {}),
      ...(preset.description !== '' ? { description: preset.description } : {}),
      order: preset.order,
      plugins: declared
    }
  }
  const plugins = []
  const prefix = typeof preset.prompt?.prefix === 'string' ? preset.prompt.prefix : ''
  const suffix = typeof preset.prompt?.suffix === 'string' ? preset.prompt.suffix : ''
  const complete = preset.complete === true
  if (prefix.trim() !== '' || suffix.trim() !== '') {
    const config = { prefix }
    if (complete) {
      // Whole-prompt replacement: the persona row becomes the only section.
      config.complete = true
      config.includeRuntimeContext = false
    } else if (suffix.trim() !== '') {
      config.suffix = suffix
    }
    plugins.push({ id: 'persona', name: '@deepseek-ai/dsh-persona', config })
  }
  for (const name of preset.rows) {
    const entry = CATALOG_BY_NAME.get(name)
    if (entry === undefined) continue
    const override = preset.rowConfigs?.[name] ?? {}
    const known = new Set((entry.fields ?? []).map((field) => field.key))
    const merged = { ...entry.config }
    for (const [key, value] of Object.entries(override)) {
      if (known.size > 0 && !known.has(key)) continue
      merged[key] = value
    }
    plugins.push({ id: entry.rowId, name: entry.name, config: merged })
  }
  for (const id of Array.isArray(preset.templates) ? preset.templates : []) {
    const template = TEMPLATE_BY_ID.get(id)
    if (template === undefined) continue
    plugins.push({
      id: template.id,
      name: "cordis:group",
      group: true,
      ...(template.isolate === null ? {} : { isolate: template.isolate }),
      config: template.rows.map((row) => structuredClone(row))
    })
  }
  return {
    id: preset.id,
    ...(preset.name !== '' ? { name: preset.name } : {}),
    ...(preset.description !== '' ? { description: preset.description } : {}),
    order: preset.order,
    plugins
  }
}

/**
 * Controller owned by `index.js`.
 * @param {{ store: object, logger?: object }} deps
 */
export function createAgentPresets ({ store, logger, subagentProviders }) {
  /** @type {any} */
  let service = null
  /** @type {Map<string, () => Promise<void>>} */
  const disposers = new Map()
  /** @type {Map<string, string>} */
  const failures = new Map()

  const log = (level, message) => {
    try {
      logger?.[level]?.(`prompt-lab: ${message}`)
    } catch {
      /* logging must never break registration */
    }
  }

  function read () {
    try {
      return normalizeDoc(store.readAgentPresets(emptyDoc()))
    } catch (error) {
      log('warn', `cannot read agent presets: ${error?.message ?? error}`)
      return emptyDoc()
    }
  }

  function write (doc) {
    store.writeAgentPresets(normalizeDoc(doc))
  }

  function fragments () {
    let library
    try {
      library = store.library()
    } catch {
      return []
    }
    return (library?.fragments ?? [])
      .filter((fragment) => typeof fragment?.text === 'string' && fragment.text.trim() !== '')
      .map((fragment) => ({
        id: fragment.id,
        label: typeof fragment.label === 'string' && fragment.label !== '' ? fragment.label : '(未命名片段)',
        key: typeof fragment.key === 'string' ? fragment.key : '',
        mode: fragment.mode === 'empty' ? 'empty' : 'replace',
        target: fragment.target === 'insert' ? 'insert' : 'override',
        preview: fragment.text.slice(0, 160)
      }))
  }

  function materialize (prompt) {
    const options = new Map(fragments().map((option) => [option.id, option]))
    const parts = []
    for (const id of prompt.fragmentIds) {
      const option = options.get(id)
      if (option === undefined) continue
      const fragment = store.library().fragments.find((entry) => entry.id === id)
      if (fragment && fragment.text.trim() !== '') parts.push(fragment.text)
    }
    if (prompt.text.trim() !== '') parts.push(prompt.text)
    return parts.join('\n\n')
  }

  async function safeList () {
    if (service === null) return []
    try {
      return await service.list()
    } catch (error) {
      log('warn', `cannot read the preset roster: ${error?.message ?? error}`)
      return []
    }
  }

  async function disposeOne (id) {
    const dispose = disposers.get(id)
    if (dispose === undefined) return
    disposers.delete(id)
    try {
      await dispose()
    } catch (error) {
      log('warn', `cannot unregister agent preset ${id}: ${error?.message ?? error}`)
    }
  }

  async function registerOne (preset) {
    failures.delete(preset.id)
    await disposeOne(preset.id)
    if (service === null) {
      failures.set(preset.id, 'agentPresets 服务不可用')
      return { id: preset.id, registered: false, error: 'agentPresets 服务不可用' }
    }
    try {
      const dispose = await service.register(buildDefinition(preset))
      disposers.set(preset.id, dispose)
      log('info', `registered agent preset ${preset.id}`)
      return { id: preset.id, registered: true }
    } catch (error) {
      const message = String(error?.message ?? error)
      failures.set(preset.id, message)
      log('warn', `cannot register agent preset ${preset.id}: ${message}`)
      return { id: preset.id, registered: false, error: message }
    }
  }

  /**
   * Group templates whose provider rows the Host can actually mount. A `null`
   * probe result means "cannot tell here", which keeps the template rather than
   * hiding a working one; an empty result hides it.
   */
  function templateOptions () {
    if (typeof subagentProviders !== 'function') return ROW_TEMPLATES
    return ROW_TEMPLATES.filter((template) => {
      const required = templateProviders(template)
      if (required.length === 0) return true
      let available
      try {
        available = subagentProviders(required)
      } catch {
        return true
      }
      return available === null || available === undefined || available.length > 0
    })
  }

  async function state () {
    const doc = read()
    const roster = await safeList()
    const rosterById = new Map(roster.map((entry) => [entry.id, entry]))
    const owned = new Set(doc.presets.map((preset) => preset.id))
    return {
      version: AGENT_PRESET_VERSION,
      supported: service !== null,
      limit: AGENT_PRESET_LIMIT,
      limits: {
        text: AGENT_PRESET_TEXT_LIMIT,
        config: AGENT_PRESET_CONFIG_LIMIT,
        rows: AGENT_PRESET_ROW_LIMIT
      },
      reservedIds: [...RESERVED_IDS],
      platform: process.platform,
      catalog: ROW_CATALOG.filter((entry) => entry.kind === 'row').map(({ name, label, note, group, kind, config, fields, tools, platform }) => ({
        name,
        label,
        note,
        group,
        kind,
        platform,
        config,
        fields,
        tools,
        required: fields.filter((field) => field.required).map((field) => field.key)
      })),
      templates: templateOptions(),
      copyOnly: COPY_ONLY,
      schemaStatus: SCHEMA_STATUS,
      fragments: fragments(),
      roster,
      failures: [...failures].map(([id, error]) => ({ id, error })),
      // Declarations this plugin does not own: shipped presets and presets
      // registered by other bundles. Read-only here; only `copy` consumes them.
      official: roster
        .filter((entry) => !owned.has(entry.id))
        .map((entry) => ({
          id: entry.id,
          name: entry.name ?? entry.id,
          description: entry.description ?? '',
          order: entry.order ?? null,
          broken: entry.broken ?? null
        })),
      presets: doc.presets.map((preset) => {
        const entry = rosterById.get(preset.id)
        return {
          ...preset,
          runtime: {
            mounted: entry !== undefined && entry.broken === undefined,
            broken: entry?.broken ?? null,
            registered: disposers.has(preset.id),
            foreign: entry !== undefined && !owned.has(preset.id)
          }
        }
      })
    }
  }

  /**
   * Validate one panel submission and persist it.
   * @returns registration outcome; the roster is the source of truth for whether
   * the composition works, not this value.
   */
  async function save (input) {
    const doc = read()
    const entry = input && typeof input === 'object' ? input : {}
    const roster = await safeList()
    const owned = new Set(doc.presets.map((preset) => preset.id))
    const existing = doc.presets.find((preset) => preset.id === String(entry.id ?? '').trim().toLowerCase())

    const id = clip(typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : '', 40)
    if (!ID_PATTERN.test(id)) {
      throw new Error('id 只能用小写字母、数字和连字符，且以字母开头（2–33 位）')
    }
    if (RESERVED_IDS.includes(id)) {
      throw new Error(`"${id}" 是内置预设 id，不能占用；请换一个 id`)
    }
    if (roster.some((row) => row.id === id && !owned.has(id))) {
      throw new Error(`名册里已经有 id "${id}"，请换一个 id`)
    }
    if (existing === undefined && doc.presets.length >= AGENT_PRESET_LIMIT) {
      throw new Error(`最多保存 ${AGENT_PRESET_LIMIT} 个 Agent 预设`)
    }

    const rows = Array.isArray(entry.rows)
      ? [...new Set(entry.rows.filter((name) => CATALOG_BY_NAME.has(name)))]
      : []
    // A copied preset carries its own complete row list; it bypasses the catalog
    // and the persona materialization below.
    const templateIds = Array.isArray(entry.templates)
      ? [...new Set(entry.templates.filter((id) => typeof id === "string" && TEMPLATE_BY_ID.has(id)))]
      : []
    const shellConflict = templateIds.includes("persistent-shell")
      && rows.some((name) => name === "@deepseek-ai/dsh-tool-bash" || name === "@deepseek-ai/dsh-tool-pwsh")
    if (shellConflict) throw new Error("「持久 shell」模板与 bash/pwsh 行不能同时使用（会重复注册同名工具）")
    const rowConfigs = normalizeRowConfigs(entry.rowConfigs)
    const declaredPlugins = sanitizePlugins(entry.plugins, { strict: true })
    assertRequiredConfig(declaredPlugins)
    // A copied complete persona carries the prompt inside its config; the same
    // text cap applies there as in the editor.
    for (const row of declaredPlugins) {
      if (row.name !== '@deepseek-ai/dsh-persona') continue
      const personaPrefix = row.config?.prefix
      if (typeof personaPrefix === 'string' && personaPrefix.length > AGENT_PRESET_TEXT_LIMIT) {
        throw new Error(`提示词正文 ${personaPrefix.length} 字，超过 ${AGENT_PRESET_TEXT_LIMIT} 字上限`)
      }
    }
    const promptInput = entry.prompt && typeof entry.prompt === 'object' ? entry.prompt : {}
    const complete = declaredPlugins.length === 0 && entry.complete === true
    // A complete preset is one whole prompt: fragments and suffix do not apply.
    const fragmentIds = declaredPlugins.length > 0 || complete
      ? []
      : Array.isArray(promptInput.fragmentIds)
        ? promptInput.fragmentIds.filter((value) => typeof value === 'string')
        : []
    const rawText = declaredPlugins.length > 0 || typeof promptInput.text !== 'string'
      ? ''
      : promptInput.text
    if (rawText.length > AGENT_PRESET_TEXT_LIMIT) {
      throw new Error(`提示词正文 ${rawText.length} 字，超过 ${AGENT_PRESET_TEXT_LIMIT} 字上限`)
    }
    const prompt = {
      fragmentIds,
      text: rawText,
      suffix: declaredPlugins.length > 0 || complete
        ? ''
        : clip(typeof promptInput.suffix === 'string' ? promptInput.suffix : '', AGENT_PRESET_TEXT_LIMIT),
      prefix: ''
    }
    const prefix = declaredPlugins.length > 0 ? '' : materialize(prompt)
    if (prefix.length > AGENT_PRESET_TEXT_LIMIT) {
      throw new Error(`提示词正文超过 ${AGENT_PRESET_TEXT_LIMIT} 字符上限`)
    }
    if (complete && prefix.trim() === '') {
      throw new Error('完整提示词不能为空')
    }
    prompt.prefix = prefix

    const preset = {
      id,
      name: clip(typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id, AGENT_PRESET_NAME_LIMIT),
      description: clip(typeof entry.description === 'string' ? entry.description.trim() : '', AGENT_PRESET_DESCRIPTION_LIMIT),
      order: normalizeOrder(entry.order, existing?.order ?? 100),
      enabled: entry.enabled !== false,
      complete: declaredPlugins.length > 0 ? false : complete,
      rows: declaredPlugins.length > 0 ? [] : rows,
      plugins: declaredPlugins,
      templates: declaredPlugins.length > 0 ? [] : templateIds,
      rowConfigs: declaredPlugins.length > 0 ? {} : rowConfigs,
      prompt,
      updatedAt: Date.now()
    }

    if (existing === undefined) doc.presets.push(preset)
    else doc.presets[doc.presets.indexOf(existing)] = preset
    doc.presets.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    write(doc)

    const runtime = preset.enabled
      ? await registerOne(preset)
      : await (async () => {
        await disposeOne(preset.id)
        failures.delete(preset.id)
        return { id: preset.id, registered: false, error: null }
      })()
    return { ...(await state()), saved: { id: preset.id, ...runtime } }
  }

  async function remove (rawId) {
    const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : ''
    const doc = read()
    const index = doc.presets.findIndex((preset) => preset.id === id)
    if (index < 0) throw new Error(`没有 id 为 "${id}" 的 Agent 预设`)
    doc.presets.splice(index, 1)
    write(doc)
    await disposeOne(id)
    failures.delete(id)
    return await state()
  }

  /** Re-register every enabled definition; called once the service is available. */
  async function attach (agentPresetsService) {
    if (service !== null) return 0
    service = agentPresetsService
    let count = 0
    for (const preset of read().presets) {
      if (!preset.enabled) continue
      const outcome = await registerOne(preset)
      if (outcome.registered) count += 1
    }
    log('info', `agent presets: ${count} registered`)
    return count
  }

  async function disposeAll () {
    for (const id of [...disposers.keys()]) await disposeOne(id)
  }

  /**
   * Drop every registration without touching stored definitions. The data wipe
   * path calls this after removing the library directory: the file is gone, but
   * a definition registered in this process would otherwise stay on the roster
   * until the next Host restart.
   */
  async function reset () {
    await disposeAll()
    failures.clear()
  }

  /** Parse one declaration's entry-list YAML, preserving `!!js` placeholders. */
  async function parseEntryList (content) {
    const mod = await import('js-yaml')
    const yaml = mod.default ?? mod
    const placeholder = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      construct: (value) => ({ __jsExpr: String(value) })
    })
    const schema = yaml.DEFAULT_SCHEMA.extend([placeholder])
    const parsed = yaml.load(content, { schema })
    if (!Array.isArray(parsed)) throw new Error('声明内容不是插件行列表')
    return parsed
  }

  /**
   * Copy any declaration this plugin does not own (a shipped preset, or one
   * registered by another bundle) into a new custom preset. The official
   * definition is never modified: the registry has no write path for it.
   */
  async function copy (rawId) {
    if (service === null) throw new Error('当前 DSH 没有 agentPresets 服务，无法复制')
    const source = typeof rawId === 'string' ? rawId.trim() : ''
    if (source === '') throw new Error('缺少要复制的预设 id')
    const doc = read()
    if (doc.presets.some((preset) => preset.id === source)) {
      throw new Error(`"${source}" 已经是本插件的预设，直接编辑即可`)
    }
    let document
    try {
      document = await service.readDocument(source)
    } catch (error) {
      throw new Error(`读取预设 "${source}" 失败：${error?.message ?? error}`)
    }
    const plugins = sanitizePlugins(await parseEntryList(document?.content ?? ''))
    if (plugins.length === 0) throw new Error(`预设 "${source}" 没有可复制的插件行`)

    const roster = await safeList()
    const taken = new Set([
      ...doc.presets.map((preset) => preset.id),
      ...roster.map((row) => row.id),
      ...RESERVED_IDS
    ])
    const base = `${source}-copy`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 26) || 'copy'
    let id = base
    let attempt = 2
    while (taken.has(id) && attempt <= 99) {
      id = `${base}-${attempt}`
      attempt += 1
    }
    if (taken.has(id)) throw new Error('无法生成不冲突的预设 id，请先清理旧副本')

    const sourceRow = roster.find((row) => row.id === source)
    const label = (sourceRow?.name ?? document?.name ?? source).trim() || source
    const order = (Number.isFinite(sourceRow?.order) ? sourceRow.order : 100) + 1
    return await save({
      id,
      name: `${label} 副本`,
      description: `复制自 ${source}`,
      order,
      enabled: true,
      rows: [],
      plugins,
      prompt: { fragmentIds: [], text: '', suffix: '' }
    })
  }

  return { attach, disposeAll, reset, state, save, remove, copy }
}
