/**
 * Prompt Lab — Host half.
 *
 * Gives ONE explicitly enabled session a prompt-section editor:
 *  - samples the official assembly once per live agent (`agent/created`),
 *    before any override exists,
 *  - writes overrides through `agent.ctx.systemPrompt.section()`, scoped to
 *    that agent, instead of listening to `system-prompt/assemble`,
 *  - detects a `complete` preset with an empty sentinel and reports it as
 *    "editing has no effect" rather than silently dropping the user's work.
 *
 * The panel talks to this file through a prefix route on the Harness web
 * server (`/prompt-lab/api`). Nothing here changes a session that has not
 * been switched on, and no session log file is ever touched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ROUTE, createApi, createHandler } from './lib/api.js'
import { createEngine } from './lib/engine.js'
import { diagnoseProbeError } from './lib/diagnostics.js'
import { classifySessions } from './lib/liveness.js'
import { copyDataDirs, hasMeaningfulData, hasOwnedData, migratePending, migrationPathError, targetHasUnexpectedContents } from './lib/migrate.js'
import { ensureWorkspaceWarning } from './lib/workspace-warning.js'
import { createPendingStore } from './lib/pending.js'
import { Store, DEFAULT_CONFIG, bootstrapDir, readBootstrapConfig, resolveDataDir, resolveDshHome, writeBootstrapConfig } from './lib/store.js'

function warnSafely (logger, message) {
  try {
    logger?.warn?.(message)
  } catch {
    /* logging must never break assembly */
  }
}

/** @param {any} ctx @param {{ dataDir?: string } | undefined} config */
export function apply (ctx, config = {}) {
  const warnings = []
  const settings = readBootstrapConfig()
  const fromPatch = typeof config?.dataDir === 'string' && config.dataDir.trim() !== ''
  let store
  let startupDir = null
  let configuredDir
  try {
    configuredDir = resolveDataDir(config, warnings)
  } catch (error) {
    warnSafely(ctx.logger, `prompt-lab: storage unavailable: ${error?.message ?? error}`)
    return
  }
  if (!fromPatch && settings.pendingMigration !== undefined) {
    const migration = migratePending(settings, {
      bootstrapDir: bootstrapDir(),
      writeConfig: writeBootstrapConfig
    })
    if (migration.ok === true) {
      if (migration.warning) warnings.push(migration.warning)
      startupDir = migration.to
    } else {
      warnings.push(`数据目录迁移失败，继续使用旧目录：${migration.error}`)
      if (typeof migration.from === 'string' && fs.existsSync(migration.from)) startupDir = migration.from
    }
  } else if (!fromPatch && settings.previousDataDir === undefined) {
    // Compatibility recovery: versions before the migration feature changed
    // dataDir in config.json without recording a pending move. If the configured
    // directory has no Prompt Lab data and the bootstrap directory still does,
    // copy it once and record the old directory for cleanup.
    const legacySource = bootstrapDir()
    if (configuredDir !== legacySource) {
      try {
        if (hasOwnedData(legacySource) && !hasMeaningfulData(configuredDir)) {
          const pathError = migrationPathError(legacySource, configuredDir, { bootstrapDir: legacySource })
          if (pathError !== null) {
            warnings.push(`旧存储位置无法自动迁移：${pathError}`)
            startupDir = legacySource
          } else if (targetHasUnexpectedContents(configuredDir, { bootstrapDir: legacySource })) {
            warnings.push('旧存储位置自动迁移失败：新目录里已有其他文件，拒绝写入')
            startupDir = legacySource
          } else {
            const copied = copyDataDirs(legacySource, configuredDir)
            if (copied.ok === true) {
              settings.previousDataDir = legacySource
              try {
                writeBootstrapConfig(settings)
              } catch (error) {
                warnings.push(`旧存储位置已复制，但迁移标记未能写入：${error?.message ?? error}`)
              }
              warnings.push('检测到旧版本已更换存储位置，已从默认目录自动迁移数据；旧目录保留，可在设置中清理')
              startupDir = configuredDir
            } else {
              settings.pendingMigration = { from: legacySource, to: configuredDir, at: Date.now() }
              try {
                writeBootstrapConfig(settings)
              } catch {
                /* best effort; the warning below still explains the state */
              }
              warnings.push(`旧存储位置自动迁移失败：${copied.error}`)
              startupDir = legacySource
            }
          }
        }
      } catch (error) {
        warnings.push(`旧存储位置检查失败：${error?.message ?? error}`)
      }
    }
  }
  try {
    const dir = startupDir ?? configuredDir
    store = new Store(dir, warnings, () => settings)
    store.ensure()
  } catch (error) {
    warnSafely(ctx.logger, `prompt-lab: storage unavailable: ${error?.message ?? error}`)
    return
  }
  try {
    store.sanitizeReadOnly()
  } catch (error) {
    warnSafely(ctx.logger, `prompt-lab: read-only cleanup failed: ${error?.message ?? error}`)
  }
  try {
    store.migrateInlineSections()
  } catch (error) {
    warnSafely(ctx.logger, `prompt-lab: section text migration failed: ${error?.message ?? error}`)
  }
  const dataDirSource = fromPatch ? 'patch' : (settings.dataDir !== undefined ? 'bootstrap' : 'default')
  const pendingStore = createPendingStore(store.dir)
  // A pending write is only consumed by a later Host process. The same process
  // must stay locked: its Agent still has the old in-memory turn counter.
  const processToken = randomUUID()
  let disposed = false
  const scheduledTimers = new Set()
  const scheduleTask = (callback, delay) => {
    if (disposed) return null
    const timer = setTimeout(() => {
      scheduledTimers.delete(timer)
      if (disposed) return
      try {
        callback()
      } catch (error) {
        warnSafely(ctx.logger, `prompt-lab: scheduled task failed: ${error?.message ?? error}`)
      }
    }, delay)
    scheduledTimers.add(timer)
    return timer
  }

  const lookup = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
  const releaseOf = () => {
    try {
      const modules = lookup('clientModules')
      // `graph()` is the public accessor; `release` itself is an internal field
      // that has been the only source in older Harness builds.
      const version = typeof modules?.graph === 'function'
        ? modules.graph()?.release?.version
        : modules?.release?.version
      return typeof version === 'string' ? version : null
    } catch {
      return null
    }
  }

  // The warning file is part of the data directory: created once at startup,
  // copied by migration, and removed together with the data on cleanup/wipe.
  try {
    const result = ensureWorkspaceWarning({
      dataDir: store.dir,
      version: releaseOf() ?? 'unknown',
      logger: ctx.logger
    })
    if (result.ok !== true) {
      warnSafely(ctx.logger, `prompt-lab: workspace warning file failed: ${result.error}`)
    }
  } catch (error) {
    warnSafely(ctx.logger, `prompt-lab: workspace warning file failed: ${error?.message ?? error}`)
  }

  const agentOf = (sessionId) => {
    try {
      const agents = lookup('agents')
      return typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    } catch {
      return undefined
    }
  }

  const toolRestrictions = new Map()
  const toolServiceOf = (agent) => {
    try {
      if (agent?.ctx?.tools !== undefined) return agent.ctx.tools
      return lookup('tools')
    } catch {
      return undefined
    }
  }
  const disposeToolRestriction = (sessionId) => {
    const entry = toolRestrictions.get(String(sessionId))
    if (entry === undefined) return
    toolRestrictions.delete(String(sessionId))
    try {
      entry.dispose()
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: cannot clear tool restriction: ${error?.message ?? error}`)
    }
  }
  const disposeAllToolRestrictions = () => {
    for (const sessionId of [...toolRestrictions.keys()]) disposeToolRestriction(sessionId)
  }
  const toolListForApi = (sessionId) => {
    const state = store.stateFor(sessionId)
    const deny = Array.isArray(state.toolPolicy?.deny)
      ? [...new Set(state.toolPolicy.deny.filter((name) => typeof name === 'string'))]
      : []
    const agent = agentOf(sessionId)
    const service = toolServiceOf(agent)
    const tools = new Map()
    const globalNames = new Set()
    const add = (schema, source) => {
      if (schema === null || typeof schema !== 'object' || typeof schema.name !== 'string') return
      if (!tools.has(schema.name)) {
        tools.set(schema.name, {
          name: schema.name,
          description: typeof schema.description === 'string' ? schema.description.slice(0, 500) : '',
          source
        })
      }
    }
    try {
      for (const schema of service?.schemas?.(agent) ?? []) add(schema, 'agent')
    } catch { /* no agent visibility */ }
    try {
      for (const schema of service?.schemas?.() ?? []) {
        if (typeof schema?.name === 'string') globalNames.add(schema.name)
        add(schema, 'global')
      }
    } catch { /* no global registry */ }
    for (const name of deny) {
      if (!tools.has(name)) {
        tools.set(name, { name, description: '', source: 'policy' })
      }
    }
    return {
      enabled: store.isEnabledFor(sessionId),
      hasAgent: agent !== undefined,
      policy: { deny },
      tools: [...tools.values()].map((tool) => {
        let visible = false
        try {
          visible = service?.get?.(tool.name, agent) !== undefined
        } catch {
          visible = false
        }
        return {
          ...tool,
          denied: deny.includes(tool.name),
          visible,
          global: globalNames.has(tool.name),
          section: `tool:${tool.name}`
        }
      }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    }
  }
  const applyToolPolicy = (sessionId, agent = agentOf(sessionId)) => {
    const id = String(sessionId)
    disposeToolRestriction(id)
    const enabled = store.isEnabledFor(id)
    // Subagents and untouched sessions are the common path. Do not materialize
    // and cache a full empty state for every one of them.
    if (!enabled) {
      try {
        engine.setSuppressedSections(id, [])
      } catch {
        /* suppression is best-effort */
      }
      return
    }
    const state = store.stateFor(id)
    const deny = Array.isArray(state.toolPolicy?.deny)
      ? [...new Set(state.toolPolicy.deny.filter((name) => typeof name === 'string' && name !== ''))]
      : []
    try {
      engine.setSuppressedSections(id, deny.map((name) => `tool:${name}`))
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: cannot suppress tool sections: ${error?.message ?? error}`)
    }
    if (agent === undefined) return
    const service = toolServiceOf(agent)
    if (service === undefined || typeof service.restrict !== 'function') return
    const valid = []
    for (const name of deny) {
      try {
        // `restrict` is global-tool only; skip scoped-only and unknown names.
        if (service.get(name) !== undefined) valid.push(name)
      } catch {
        /* unknown name */
      }
    }
    if (valid.length === 0) return
    try {
      const dispose = service.restrict({ deny: valid })
      toolRestrictions.set(id, { dispose, deny: valid })
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: cannot apply tool restriction: ${error?.message ?? error}`)
    }
  }
  const activeTransientTurns = new Map()

  const transientEntries = (state, sessionId) => (Array.isArray(state.transientSections) ? state.transientSections : [])
    .filter((entry) => entry && entry.enabled !== false)
    .filter((entry) => !Number.isFinite(entry.consumedAtTurn))
    .map((entry) => ({ ...entry, text: store.sectionTextOf(entry, sessionId) }))

  const markTransientsConsumed = (id, active) => {
    try {
      const state = store.stateFor(id)
      let changed = false
      for (const entry of active.entries) {
        const stored = (state.transientSections ?? []).find((item) => item.id === entry.id)
        if (stored === undefined || Number.isFinite(stored.consumedAtTurn)) continue
        // A reset/edit during the turn creates a newer revision. Do not consume
        // the old active snapshot over the user's edited definition.
        if (entry.updatedAt !== undefined && stored.updatedAt !== entry.updatedAt) continue
        stored.consumedAtTurn = active.turn
        changed = true
      }
      if (changed && store.hasDraft(id) !== true) store.saveState(id, state)
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: cannot mark transient sections consumed: ${error?.message ?? error}`)
    }
  }

  const finishTransients = (sessionId, agent, consume) => {
    const id = String(sessionId)
    const active = activeTransientTurns.get(id)
    if (active === undefined) return
    activeTransientTurns.delete(id)
    try {
      engine.deactivateTransients(id, agent ?? active.agent)
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: cannot clear transient sections: ${error?.message ?? error}`)
    }
    if (consume === true && active.entered === true) markTransientsConsumed(id, active)
  }

  const armTransients = (sessionId, agent, turn) => {
    const id = String(sessionId)
    if (store.isEnabledFor(id) !== true) {
      finishTransients(id, agent, false)
      return
    }
    let complete = false
    try {
      complete = engine.describe(id).completeActive === true
    } catch {
      complete = false
    }
    if (complete) {
      finishTransients(id, agent, false)
      return
    }
    const active = activeTransientTurns.get(id)
    if (active !== undefined && active.turn === turn) return
    if (active !== undefined) finishTransients(id, agent, true)
    const entries = transientEntries(store.stateFor(id), id)
    if (entries.length === 0) return
    if (engine.activateTransients(id, agent, entries) === true) {
      activeTransientTurns.set(id, { agent, turn, entries, entered: false })
    }
  }

  const onTransientChanged = (sessionId, transientId) => {
    const id = String(sessionId)
    const active = activeTransientTurns.get(id)
    if (active === undefined) return
    if (transientId !== undefined && !active.entries.some((entry) => entry.id === transientId)) return
    activeTransientTurns.delete(id)
    try {
      engine.deactivateTransients(id, active.agent)
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: cannot reset transient registration: ${error?.message ?? error}`)
    }
  }

  const readInstructions = (sessionId) => {
    const sid = String(sessionId)
    const agent = agentOf(sid)
    let session = agent?.session
    if (session === undefined) {
      try {
        session = lookup('sessions')?.get?.(sid)
      } catch {
        session = undefined
      }
    }
    const cwd = session?.header?.cwd ?? session?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      return { ok: false, reason: 'no-cwd', cwd: null, files: [], notes: ['当前会话没有可用的工作目录'] }
    }
    const resolved = path.resolve(cwd)
    const candidates = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
    const maxSource = 128 * 1024
    const maxTotal = 256 * 1024
    let total = 0
    const files = []
    const seen = new Set()
    const notes = []

    const add = (file, scope) => {
      try {
        if (!fs.existsSync(file)) return
        const stat = fs.statSync(file)
        if (!stat.isFile()) return
        if (total >= maxTotal) {
          notes.push(`已达到总大小上限，跳过 ${file}`)
          return
        }
        const length = Math.min(stat.size, maxSource, maxTotal - total)
        const buffer = Buffer.alloc(length)
        const fd = fs.openSync(file, 'r')
        try {
          fs.readSync(fd, buffer, 0, length, 0)
        } finally {
          fs.closeSync(fd)
        }
        const text = buffer.toString('utf8')
        const key = text.trim()
        if (key !== '' && seen.has(key)) return
        if (key !== '') seen.add(key)
        total += length
        files.push({
          path: file,
          scope,
          bytes: stat.size,
          truncated: stat.size > length,
          text
        })
      } catch (error) {
        notes.push(`读取失败 ${file}: ${error?.message ?? error}`)
      }
    }

    add(path.join(resolveDshHome(), 'AGENTS.md'), 'global')
    const agentsHome = process.env.DSH_AGENTS_HOME ?? path.join(os.homedir(), '.agents')
    add(path.join(agentsHome, 'AGENTS.md'), 'global')

    let root = resolved
    let cursor = resolved
    while (true) {
      if (fs.existsSync(path.join(cursor, '.git'))) {
        root = cursor
        break
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    const dirs = []
    cursor = resolved
    while (true) {
      dirs.unshift(cursor)
      if (cursor === root) break
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    for (const dir of dirs) {
      for (const candidate of candidates) add(path.join(dir, candidate), 'project')
    }
    return { ok: true, cwd: resolved, root, files, notes }
  }

  const liveSessionOf = (sessionId) => {
    const agent = agentOf(sessionId)
    if (agent?.session !== undefined) return agent.session
    try {
      return lookup('sessions')?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  const appendUserMessage = async (sessionId, value) => {
    const session = liveSessionOf(sessionId)
    if (session === undefined) return { ok: false, reason: 'not-running' }
    if (store.isEnabledFor(sessionId) !== true) return { ok: false, reason: 'disabled' }
    const agent = agentOf(sessionId)
    if (agent !== undefined && agent.status !== undefined && agent.status !== 'idle') {
      return { ok: false, reason: 'not-idle' }
    }
    const boundary = turnBoundaryOf(session)
    if (!Number.isFinite(boundary?.lastTurn) || boundary.lastTurn <= 0) {
      return { ok: false, reason: 'no-turn' }
    }
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: value }],
      source: { kind: 'user' }
    }
    session.append('user/message', message, { surfaceOp: 'append' })
    try {
      await lookup('sessions')?.flush?.(session)
    } catch {
      /* the event is already in the live log; persistence owns its retry */
    }
    return { ok: true, id: message.id }
  }

  const syntheticTurn = (turn, messages) => {
    const inputs = [
      ['turn/start', { turn }],
      ['step/start', { turn, step: 1 }]
    ]
    if (messages.user !== undefined) inputs.push(['user/message', messages.user, { surfaceOp: 'append' }])
    if (messages.assistant !== undefined) {
      const text = messages.assistant.content[0].text
      inputs.push(['assistant/message', {
        turn,
        step: 1,
        message: messages.assistant,
        stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [0], texts: [text] }]
      }, { surfaceOp: 'append' }])
    }
    inputs.push(
      ['step/end', { turn, step: 1 }],
      ['turn/end', { turn, reason: { kind: 'completed' } }]
    )
    return inputs
  }

  const flushSession = async (session) => {
    try {
      return await lookup('sessions')?.flush?.(session) !== false
    } catch {
      return false
    }
  }

  const appendAssistantMessage = async (sessionId, value) => {
    const session = liveSessionOf(sessionId)
    if (session === undefined) return { ok: false, reason: 'not-running' }
    if (store.isEnabledFor(sessionId) !== true) return { ok: false, reason: 'disabled' }
    const agent = agentOf(sessionId)
    if (agent !== undefined && agent.status !== undefined && agent.status !== 'idle') {
      return { ok: false, reason: 'not-idle' }
    }
    const boundary = turnBoundaryOf(session)
    const lastTurn = Number.isFinite(boundary?.lastTurn) ? boundary.lastTurn : 0
    if (lastTurn <= 0) return { ok: false, reason: 'no-turn' }
    let selection
    try {
      selection = typeof agent?.model?.current === 'function' ? agent.model.current() : undefined
    } catch {
      selection = undefined
    }
    if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      return { ok: false, reason: 'no-model' }
    }
    const turn = lastTurn + 1
    const message = {
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text: value }],
      source: { kind: 'model', provider: selection.provider, model: selection.model }
    }
    try {
      session.append(syntheticTurn(turn, { assistant: message }))
    } catch (error) {
      return { ok: false, reason: 'append-failed', detail: String(error?.message ?? error) }
    }
    const flushed = await flushSession(session)
    pendingStore.write(sessionId, {
      kind: 'append',
      processId: processToken,
      syntheticTurn: turn,
      assistantId: message.id,
      status: 'awaiting-reload',
      locked: true,
      flushed,
      createdAt: Date.now()
    })
    return { ok: true, id: message.id, reloadRequired: true, locked: true, flushed, syntheticTurn: turn }
  }

  const prefillSend = async (sessionId, value, assistantTextOverride) => {
    const session = liveSessionOf(sessionId)
    if (session === undefined) return { ok: false, reason: 'not-running' }
    if (store.isEnabledFor(sessionId) !== true) return { ok: false, reason: 'disabled' }
    const agent = agentOf(sessionId)
    if (agent === undefined) return { ok: false, reason: 'not-running' }
    if (agent.status !== undefined && agent.status !== 'idle') return { ok: false, reason: 'not-idle' }
    const boundary = turnBoundaryOf(session)
    const lastTurn = Number.isFinite(boundary?.lastTurn) ? boundary.lastTurn : 0
    if (lastTurn <= 0) return { ok: false, reason: 'no-turn' }
    let assistantText = typeof assistantTextOverride === 'string' ? assistantTextOverride : ''
    if (assistantText.trim() === '') {
      // Legacy fallback: pre-0.7.0 clients sent only the user text and relied on
      // the saved prefill config. The current panel passes both texts directly.
      const auto = store.stateFor(sessionId).autoAssistant ?? {}
      if (auto.enabled !== true) return { ok: false, reason: 'prefill-disabled' }
      assistantText = store.messageTextOf(auto)
    }
    if (assistantText.trim() === '') return { ok: false, reason: 'prefill-empty' }
    let selection
    try {
      selection = typeof agent.model?.current === 'function' ? agent.model.current() : undefined
    } catch {
      selection = undefined
    }
    if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      return { ok: false, reason: 'no-model' }
    }
    const turn = lastTurn + 1
    const userMessage = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: value }],
      source: { kind: 'user' }
    }
    const assistantMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text: assistantText }],
      source: { kind: 'model', provider: selection.provider, model: selection.model }
    }
    try {
      session.append(syntheticTurn(turn, { user: userMessage, assistant: assistantMessage }))
    } catch (error) {
      return { ok: false, reason: 'append-failed', detail: String(error?.message ?? error) }
    }
    const flushed = await flushSession(session)
    const continueMessageId = randomUUID()
    pendingStore.write(sessionId, {
      kind: 'prefill',
      processId: processToken,
      syntheticTurn: turn,
      userId: userMessage.id,
      assistantId: assistantMessage.id,
      continueMessageId,
      status: 'awaiting-reload',
      locked: true,
      flushed,
      createdAt: Date.now()
    })
    return {
      ok: true,
      reloadRequired: true,
      locked: true,
      flushed,
      syntheticTurn: turn,
      userId: userMessage.id,
      assistantId: assistantMessage.id,
      continueMessageId
    }
  }

  const pendingStatus = (sessionId) => {
    const value = pendingStore.read(sessionId)
    if (value === null) return { pending: false, locked: false, status: null, kind: null, syntheticTurn: null }
    return {
      pending: true,
      locked: value.locked !== false,
      status: value.status ?? 'awaiting-reload',
      kind: value.kind ?? null,
      syntheticTurn: Number.isFinite(value.syntheticTurn) ? value.syntheticTurn : null,
      flushed: value.flushed === true
    }
  }

  const pendingUnlock = (sessionId) => {
    const value = pendingStore.read(sessionId)
    if (value === null) return pendingStatus(sessionId)
    value.locked = false
    pendingStore.write(sessionId, value)
    return pendingStatus(sessionId)
  }

  const pendingContinuations = new Set()

  const continuePending = async (agent, source) => {
    if (disposed) return
    const sessionId = agent?.id
    if (typeof sessionId !== 'string') return
    let pending = pendingStore.read(sessionId)
    if (pending === null) return
    if (pending.processId === processToken) return
    if (pendingContinuations.has(sessionId)) return
    if (store.isEnabledFor(sessionId) !== true) return
    pendingContinuations.add(sessionId)
    try {
      // Wait out maintenance/other activity without blocking the creation
      // listener itself. runMaintenance below is the race-safe wake.
      if (typeof agent.whenIdle === 'function') await agent.whenIdle()
      if (disposed) return
      if (agent.status !== undefined && agent.status !== 'idle') return
      pending = pendingStore.read(sessionId)
      if (pending === null) return
      if (pending.processId === processToken) return
      const boundary = turnBoundaryOf(agent.session)
      const lastTurn = Number.isFinite(boundary?.lastTurn) ? boundary.lastTurn : 0
      const syntheticTurn = Number(pending.syntheticTurn)
      if (Number.isFinite(syntheticTurn) && lastTurn < syntheticTurn) {
        pendingStore.write(sessionId, { ...pending, status: 'format-invalid' })
        return
      }
      if (pending.kind === 'append') {
        pendingStore.remove(sessionId)
        return
      }
      if (pending.kind !== 'prefill') return
      // A claim/send marker belongs to the previous Host process (same-process
      // writers returned above). That process died before the follow-up was
      // claimed, so retry instead of leaving the session locked forever.
      if (pending.status === 'awaiting-claim' || pending.status === 'sending') {
        pending = { ...pending, status: 'awaiting-idle' }
        pendingStore.write(sessionId, pending)
      }
      if (pending.flushed !== true) {
        const flushed = await flushSession(agent.session)
        if (!flushed) {
          pendingStore.write(sessionId, { ...pending, status: 'flush-failed' })
          return
        }
        pending = pendingStore.read(sessionId) ?? { ...pending, flushed: true }
        pendingStore.write(sessionId, { ...pending, flushed: true })
      }
      if (typeof agent.runMaintenance !== 'function') {
        pendingStore.write(sessionId, { ...pending, status: 'wake-failed' })
        return
      }
      const continueMessageId = typeof pending.continueMessageId === 'string' && pending.continueMessageId !== ''
        ? pending.continueMessageId
        : randomUUID()
      // Claim under this process token. A same-process idle event then stops at
      // the `processId === processToken` guard instead of queuing a second
      // follow-up; a different process still treats the marker as stale.
      pending = { ...pending, status: 'awaiting-claim', continueMessageId, processId: processToken }
      pendingStore.write(sessionId, pending)
      try {
        await agent.runMaintenance(async () => {
          agent.followup({
            id: continueMessageId,
            role: 'user',
            content: [{ type: 'text', text: '继续' }],
            source: { kind: 'user' }
          })
        })
      } catch (error) {
        const latest = pendingStore.read(sessionId) ?? pending
        const attempts = (Number(latest.attempts) || 0) + 1
        if (attempts < 5) {
          // Clear the claim token so the scheduled retry is not blocked by the
          // same-process guard. A later successful claim writes the current
          // token again; a different process never matches it anyway.
          pendingStore.write(sessionId, { ...latest, status: 'awaiting-idle', continueMessageId, attempts, processId: null })
          scheduleTask(() => { void continuePending(agent).catch(() => {}) }, 1000)
        } else {
          pendingStore.write(sessionId, {
            ...latest,
            status: 'wake-failed',
            continueMessageId,
            attempts,
            error: String(error?.message ?? error)
          })
        }
      }
    } catch (error) {
      const latest = pendingStore.read(sessionId) ?? pending
      if (latest !== null) {
        pendingStore.write(sessionId, { ...latest, status: 'wake-failed', error: String(error?.message ?? error) })
      }
    } finally {
      // This used to be deleted only by the runMaintenance chain, so an early
      // return (not idle, append-only, format-invalid, flush failure) left the
      // session permanently marked as "continuation in progress".
      pendingContinuations.delete(sessionId)
    }
  }

  const presetOf = async (agent) => {
    try {
      const presets = lookup('agentPresets')
      if (presets === undefined) return { id: null, name: null }
      const id = typeof presets.composedPreset === 'function' ? presets.composedPreset(agent?.ctx) : undefined
      if (typeof id !== 'string' || id === '') return { id: null, name: null }
      let name = null
      try {
        const list = await presets.list()
        name = list.find((entry) => entry.id === id)?.name ?? null
      } catch {
        /* display-only: the id is still useful */
      }
      return { id, name }
    } catch {
      return { id: null, name: null }
    }
  }
  const livenessOf = (ids) => {
    const services = {}
    for (const [key, name] of [
      ['sessions', 'sessions'],
      ['workspaceRegistry', 'workspaceRegistry'],
      ['sessionPersistence', 'sessionPersistence'],
      ['sessionTitle', 'sessionTitle']
    ]) {
      try {
        services[key] = lookup(name)
      } catch {
        services[key] = undefined
      }
    }
    services.logger = ctx.logger
    return classifySessions(ids, services)
  }

  /**
   * Assemble the session's prompt on demand: no model call, no user message,
   * no session-log write. With `force` the current registrations are removed
   * first, so the snapshot is the official assembly (used to refresh drift).
   */
  const captureNow = async (sessionId) => {
    const agent = agentOf(sessionId)
    if (agent === undefined) return { ok: false, reason: 'not-running' }
    try {
      const result = await engine.attach(agent, { force: true })
      if (result.ok !== true) {
        return {
          ok: false,
          reason: result.reason ?? 'probe-failed',
          detail: result.detail,
          attribution: result.attribution ?? diagnoseProbeError(result.detail ?? result.reason ?? 'probe-failed')
        }
      }
      const described = engine.describe(sessionId)
      return {
        ok: true,
        sections: described.sections.length,
        completeActive: described.completeActive === true
      }
    } catch (error) {
      const diagnostics = diagnoseProbeError(error)
      warnSafely(ctx.logger, `prompt-lab: capture failed: ${diagnostics.detail}`)
      return { ok: false, reason: 'probe-failed', detail: diagnostics.detail, attribution: diagnostics }
    }
  }

  /**
   * A window is a draft while DSH has not started any turn in it. The
   * turnBoundary projection is the same check `agent-preset.select()` uses to
   * lock a preset; when it is unavailable we stay conservative and treat the
   * session as committed.
   */
  const turnBoundaryOf = (session) => {
    // The owning AgentRegistry service exposes the boundary on current Hosts.
    try {
      const agents = lookup('agents')
      if (typeof agents?.turnBoundaryOf === 'function') {
        const value = agents.turnBoundaryOf(session)
        if (value !== undefined) return value
      }
    } catch {
      /* fall through to the legacy projection read */
    }
    try {
      const projections = lookup('sessionProjections')
      if (typeof projections?.stateOf === 'function') {
        return projections.stateOf(session, 'turnBoundary')
      }
    } catch {
      /* fail-open */
    }
    return undefined
  }

  const isBlankSession = (session) => {
    if (session === undefined || session === null) return false
    try {
      const boundary = turnBoundaryOf(session)
      if (boundary === undefined || boundary === null) return false
      return boundary.openTurnStartSeq === null && boundary.lastTurn === 0
    } catch {
      return false
    }
  }

  const isBlankAgent = (agent) => isBlankSession(agent?.session)

  const isDraftSession = (sessionId) => {
    if (store.hasDraft(sessionId)) return true
    if (store.hasFormalState(sessionId)) return false
    const agent = agentOf(sessionId)
    let session = agent?.session
    if (session === undefined) {
      try {
        const sessions = lookup('sessions')
        session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
      } catch {
        session = undefined
      }
    }
    if (session === undefined) return false
    return isBlankSession(session)
  }

  const engine = createEngine({ store, logger: ctx.logger, releaseOf, presetOf, isDraftSession })

  /**
   * Finish a draft commit. The baseline is sampled first so an
   * `awaitingBaseline` template never gets written as an unconditional
   * override. Failures are logged and the draft is kept for a later retry.
   */
  const commitDraftNow = async (sessionId, agent) => {
    if (store.hasDraft(sessionId) !== true) return null
    try {
      if (agent !== undefined) {
        const before = engine.describe(sessionId)
        if (before.captured !== true) {
          const attached = await engine.attach(agent)
          if (attached.ok !== true) {
            warnSafely(ctx.logger, `prompt-lab: cannot sample before draft commit: ${attached.reason}`)
          }
        }
      }
      const described = engine.describe(sessionId)
      const captureOf = (key) => {
        const row = described.sections.find((section) => section.name === key)
        if (row === undefined || typeof row.officialHash !== 'string') return null
        return { officialHash: row.officialHash, officialText: row.officialText }
      }
      const result = store.commitDraft(sessionId, { captureOf })
      engine.sync(sessionId)
      return result
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: draft commit failed: ${error?.message ?? error}`)
      return null
    }
  }

  const api = createApi({
    store,
    engine,
    dataDir: store.dir,
    dataDirSource,
    warnings,
    captureNow,
    agentOf,
    releaseOf,
    livenessOf,
    isDraftSession,
    toolsList: toolListForApi,
    instructionsOf: readInstructions,
    appendUserMessage: appendUserMessage,
    appendAssistantMessage: appendAssistantMessage,
    onTransientChanged,
    prefillSend,
    pendingStatus,
    pendingUnlock,
    onToolPolicyChanged: (sessionId) => {
      applyToolPolicy(sessionId)
      if (store.isEnabledFor(sessionId) !== true) finishTransients(sessionId, agentOf(sessionId), false)
    },
    settings: () => settings,
    saveSettings: (patch) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete settings[key]
        else settings[key] = value
      }
      writeBootstrapConfig(settings)
      return settings
    },
    wipeAllData: () => {
      const result = store.wipeAll()
      try {
        engine.shutdown()
      } catch {
        /* registrations are best-effort */
      }
      // Tool restrictions and pending continuation bookkeeping are held in this
      // plugin, not in the wiped Store. Without this, tools stay denied after a
      // "reset everything" until the next Host restart.
      disposeAllToolRestrictions()
      activeTransientTurns.clear()
      pendingContinuations.clear()
      for (const key of Object.keys(settings)) delete settings[key]
      Object.assign(settings, DEFAULT_CONFIG)
      let configRemoved = false
      try {
        const file = path.join(bootstrapDir(), 'config.json')
        if (fs.existsSync(file)) {
          fs.rmSync(file, { force: true })
          configRemoved = true
        }
      } catch (error) {
        warnings.push(`无法删除 config.json：${error?.message ?? error}`)
      }
      return { ...result, configRemoved }
    }
  })

  // A serial, awaited lifecycle hook: the baseline sample and the section
  // registrations are both in place before the agent's first turn. A failure
  // here is logged, never rethrown, because a rejection would block creation.
  ctx.on('agent/created', async ({ agent, source } = {}) => {
    if (disposed) return
    const sessionId = agent?.id
    if (typeof sessionId !== 'string') return
    try {
      // A draft left behind on a session that has already started belongs to
      // an interrupted commit (or an older blank window that was resumed);
      // finish it before installing anything.
      if (store.hasDraft(sessionId) && !isBlankAgent(agent)) {
        await commitDraftNow(sessionId, agent)
      }
      applyToolPolicy(sessionId, agent)
      if (store.isEnabledFor(sessionId) !== true) return
      const result = await engine.attach(agent)
      if (result.ok !== true) {
        warnSafely(ctx.logger, `prompt-lab: cannot install overrides for this session: ${result.reason}`)
      }
      // Never await idle from an agent/created listener. The continuation is
      // scheduled after this creation dispatch, and retried on agent/status.
      scheduleTask(() => { void continuePending(agent, source).catch(() => {}) }, 0)
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: agent/created handling failed: ${error?.message ?? error}`)
    }
  })

  /**
   * The first step is the commit point for a blank window. This listener must
   * never block the step: the commit runs first (draft overrides are already
   * live in the prompt registry) and `next()` is always called.
   */
  // Transients must be registered before the loop assembles the prompt for a
  // turn. `agent/pre-step` is too late: preStep() assembles first and only then
  // dispatches the waterfall. `turn/start` is the last event before assembly.
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    if (event?.type === 'turn/start') {
      const turn = event?.data?.turn
      if (!Number.isFinite(turn)) return
      armTransients(sessionId, agentOf(sessionId), turn)
      return
    }
    if (event?.type === 'step/start') {
      const active = activeTransientTurns.get(sessionId)
      if (active !== undefined && active.turn === event?.data?.turn) {
        active.entered = true
        // The request is now real; mark one-shot sections used immediately so
        // the panel reflects it without waiting for the whole turn to finish.
        markTransientsConsumed(sessionId, active)
      }
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const sessionId = payload?.agent?.id
      if (typeof sessionId === 'string' && store.hasDraft(sessionId)) {
        await commitDraftNow(sessionId, payload.agent)
      }
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: pre-step draft commit failed: ${error?.message ?? error}`)
    }
    return typeof next === 'function' ? next() : undefined
  })

  ctx.on('agent/status', ({ agent, status } = {}) => {
    if (status !== 'idle') return
    const sessionId = agent?.id
    if (typeof sessionId !== 'string') return
    finishTransients(sessionId, agent, true)
    try {
      void continuePending(agent).catch((error) => {
        warnSafely(ctx.logger, `prompt-lab: pending continuation failed: ${error?.message ?? error}`)
      })
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: pending continuation failed: ${error?.message ?? error}`)
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message } = {}) => {
    const sessionId = agent?.id
    if (typeof sessionId !== 'string') return
    const pending = pendingStore.read(sessionId)
    if (pending === null || pending.kind !== 'prefill') return
    if (pending.continueMessageId !== message?.id) return
    pendingStore.remove(sessionId)
  })

  ctx.on('agent/disposed', ({ agent } = {}) => {
    const sessionId = agent?.id
    if (typeof sessionId !== 'string') return
    finishTransients(sessionId, agent, true)
    disposeToolRestriction(sessionId)
    engine.detach(sessionId, agent)
    // Do not delete on disposal: a blank window may be archived (recoverable)
    // or a new Agent may be created for the same id. GC decides later.
    if (store.hasDraft(sessionId)) {
      try {
        store.touchDraft(sessionId, { closedAt: Date.now() })
      } catch (error) {
        warnSafely(ctx.logger, `prompt-lab: cannot record draft disposal: ${error?.message ?? error}`)
      }
    }
  })

  // A blank session can switch its agent preset without rebuilding the Agent.
  // The old baseline/complete/order assumptions no longer describe the new
  // composition, so sample again. Draft state/fragments are intentionally
  // kept; only the runtime sample is refreshed. This is best-effort and never
  // blocks the selection itself.
  ctx.on('agent-preset/selected', (sessionId) => {
    if (typeof sessionId !== 'string') return
    try {
      const agent = agentOf(sessionId)
      if (agent === undefined) return
      applyToolPolicy(sessionId, agent)
      if (store.hasDraft(sessionId) && !isBlankAgent(agent)) {
        void commitDraftNow(sessionId, agent).then(() => {
          if (store.isEnabledFor(sessionId) === true) void captureNow(sessionId)
        })
        return
      }
      if (store.isEnabledFor(sessionId) !== true) {
        // The preset changed while Prompt Lab is off. Drop the stale runtime
        // sample so the next enable/capture reads the new composition.
        engine.detach(sessionId, agent)
        return
      }
      void captureNow(sessionId)
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: preset re-sample failed: ${error?.message ?? error}`)
    }
  })

  // Startup GC for drafts whose blank window was discarded while the plugin
  // was not running. Waiting for sessionPersistence avoids treating a
  // not-yet-loaded persistence index as "every draft is missing"; archived
  // sessions keep theirs until TTL, and unknown persistence is never deleted.
  try {
    ctx.inject(['sessionPersistence'], () => {
      void store.gcDrafts(livenessOf).catch((error) => {
        warnSafely(ctx.logger, `prompt-lab: draft cleanup failed: ${error?.message ?? error}`)
      })
    })
  } catch (error) {
    warnSafely(ctx.logger, `prompt-lab: cannot schedule draft cleanup: ${error?.message ?? error}`)
  }

  // Registrations live on agent.ctx, which Cordis disposes with the agent.
  // This second disposer covers plugin unload for sessions still alive.
  try {
    ctx.effect(() => () => {
      disposed = true
      for (const timer of scheduledTimers) clearTimeout(timer)
      scheduledTimers.clear()
      disposeAllToolRestrictions()
      activeTransientTurns.clear()
      pendingContinuations.clear()
      engine.shutdown()
    }, 'prompt-lab: section and tool registrations')
  } catch (error) {
    warnSafely(ctx.logger, `prompt-lab: cannot own registrations: ${error?.message ?? error}`)
  }

  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(
        () => webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: createHandler(api, ctx.logger)
        }),
        'prompt-lab: api route'
      )
    } catch (error) {
      warnSafely(ctx.logger, `prompt-lab: cannot register api route: ${error?.message ?? error}`)
    }
  })
}
