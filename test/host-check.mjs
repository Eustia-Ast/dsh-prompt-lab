/**
 * Host self-check for the section-API engine.
 *
 * The fake prompt registry below mirrors the real one closely enough to verify
 * the parts this plugin owns: scoped same-name shadowing, numeric ordering,
 * `complete` forcing a single section, and registry-order introspection.
 * It also has a "no registry introspection" mode to exercise the calibration
 * fallback.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLASSIFIED_AGAINST,
  DEFAULT_CONFIG,
  Store,
  estimateTokens,
  isReadOnlySection,
  sectionSource,
  sensitivityOf
} from '../lib/store.js'
import { createEngine } from '../lib/engine.js'
import { createApi } from '../lib/api.js'
import { classifySessions } from '../lib/liveness.js'

const ORDER_KEYS = {
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  PLAN_POLICY: 500,
  TEAM_POLICY: 600,
  FILE_REFERENCE: 900,
  TOOL_BASH: 1000,
  TOOL_READ: 1100,
  TOOL_APPLY_PATCH: 1350,
  TOOL_PTY_PANEL: 1710,
  TOOL_SCHEDULE: 2500,
  MCP_SERVERS: 3100,
  TOOLS_SDK: 5000
}

function makePrompt (sections, options = {}) {
  const scoped = new Map()
  const sp = {
    section (definition) {
      if (scoped.has(definition.name)) throw new Error(`duplicate section ${definition.name}`)
      const entry = { ...definition }
      scoped.set(definition.name, entry)
      let active = true
      return () => {
        if (!active) return
        active = false
        if (scoped.get(definition.name) === entry) scoped.delete(definition.name)
      }
    },
    getSectionOrder (key) {
      return ORDER_KEYS[key]
    },
    async assemble (context = {}) {
      const merged = new Map(sections.map((section) => [section.name, section]))
      for (const [name, definition] of scoped) merged.set(name, definition)
      const definitions = [...merged.values()].sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      })
      const evaluate = (definition) => ({
        name: definition.name,
        text: typeof definition.text === 'function' ? definition.text(context) : String(definition.text ?? ''),
        ...(definition.interpolate === false ? { interpolate: false } : {})
      })
      const complete = definitions.filter((definition) => definition.complete === true)
      return {
        sections: complete.length > 0 ? [evaluate(complete[0])] : definitions.map(evaluate),
        contexts: [],
        tools: [],
        variables: {}
      }
    }
  }
  if (options.hideLayers !== true) {
    sp.layers = {
      merge () {
        const merged = new Map(sections.map((section) => [section.name, section]))
        for (const [name, definition] of scoped) merged.set(name, definition)
        return merged
      }
    }
  }
  return sp
}

function createAgent (id, sections, options = {}) {
  const prompt = makePrompt(sections, options)
  const ctx = {
    systemPrompt: prompt,
    get (name) {
      return name === 'systemPrompt' ? prompt : undefined
    },
    effect (fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    }
  }
  return {
    id,
    ctx,
    sections,
    setText (name, text) {
      const found = sections.find((section) => section.name === name)
      if (found === undefined) sections.push({ name, order: 4000, text })
      else found.text = text
    }
  }
}

function officialSections () {
  return [
    { name: 'harness:identity', order: -1000, text: 'you are dsh' },
    { name: 'plan:policy', order: 500, text: '' },
    { name: 'tool:bash', order: 1000, text: 'run bash carefully' },
    { name: 'tool:read', order: 1100, text: 'read files' },
    { name: 'acme:plugin-section', order: 3252, text: 'plugin section policy' }
  ]
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-'))
const warnings = []
const settings = { ...DEFAULT_CONFIG }
const store = new Store(dir, warnings, () => settings, { isReadOnlySection: () => false })
store.ensure()
const engine = createEngine({
  store,
  logger: { warn: (message) => warnings.push(message) },
  releaseOf: () => '0.2.2-rc.3',
  readOnlySection: () => false,
  presetOf: (agent) => agent.id === 'session-complete-1'
    ? { id: 'minimal', name: 'Minimal' }
    : { id: 'default', name: 'Default' }
})

const live = new Map()
const api = createApi({
  store,
  engine,
  dataDir: dir,
  dataDirSource: 'default',
  warnings,
  agentOf: (sessionId) => live.get(sessionId),
  releaseOf: () => '0.2.2-rc.3',
  // Existing engine/API tests intentionally edit tool:* fixtures. Production
  // read-only enforcement is covered separately with `strictApi` below.
  readOnlySection: () => false,
  livenessOf: async (ids) => new Map(ids.map((id) => [
    id,
    { id, status: live.has(id) ? 'live' : 'missing', title: null }
  ])),
  captureNow: async (sessionId) => {
    const agent = live.get(sessionId)
    if (agent === undefined) return { ok: false, reason: 'not-running' }
    const result = await engine.attach(agent, { force: true })
    if (result.ok !== true) return { ok: false, reason: result.reason }
    const described = engine.describe(sessionId)
    return { ok: true, sections: described.sections.length, completeActive: described.completeActive }
  },
  settings: () => settings,
  saveSettings: (patch) => Object.assign(settings, patch)
})

const strictApi = createApi({
  store,
  engine,
  dataDir: dir,
  dataDirSource: 'default',
  warnings,
  agentOf: (sessionId) => live.get(sessionId),
  settings: () => settings,
  saveSettings: (patch) => Object.assign(settings, patch)
})

const sid = 'session-test-1'
const agent = createAgent(sid, officialSections())
live.set(sid, agent)
const names = (assembly) => assembly.sections.map((section) => section.name)

async function main () {
  // 0. utility expectations
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 2) // 4 * 0.3 = 1.2 -> 2
  assert.equal(estimateTokens('汉字'), 2) // 2 * 0.6 = 1.2 -> 2
  assert.equal(estimateTokens('aaaa汉字'), 3) // 1.2 + 1.2 = 2.4 -> 3
  assert.equal(sectionSource('tool:bash'), 'official')
  assert.equal(sectionSource('tool:apply_patch'), 'official')
  assert.equal(sectionSource('tool:pty-panel'), 'official')
  assert.equal(sectionSource('tool:schedule'), 'official')
  assert.equal(sectionSource('computer-use:dsh-cua'), 'official')
  assert.equal(sectionSource('acme:plugin-section'), 'plugin')
  assert.equal(sensitivityOf('tool:bash'), 'capability')
  assert.equal(sensitivityOf('computer-use:dsh-cua'), 'capability')
  assert.equal(isReadOnlySection('tool:bash'), true)
  assert.equal(isReadOnlySection('computer-use:dsh-cua'), true)
  assert.equal(isReadOnlySection('tools:sdk'), true)
  assert.equal(isReadOnlySection('mcp-resource-servers'), true)
  assert.equal(isReadOnlySection('plan:policy'), false)
  await assert.rejects(
    () => strictApi.handle({ op: 'fragment.save', sessionId: sid, key: 'tool:bash', mode: 'replace', text: 'blocked' }),
    /只读/
  )

  // 1. no capture yet, nothing registered, disabled session untouched
  const before = await api.handle({ op: 'state.get', sessionId: sid })
  assert.equal(before.prompt.captured, false)
  assert.equal(before.meta.completeActive, false)
  assert.deepEqual(names(await agent.ctx.systemPrompt.assemble({ agent, scope: agent })), [
    'harness:identity', 'plan:policy', 'tool:bash', 'tool:read', 'acme:plugin-section'
  ])

  // 2. explicit capture samples the official assembly without registering anything
  const captured = await api.handle({ op: 'assemble.capture', sessionId: sid })
  assert.equal(captured.capture.ok, true)
  assert.equal(captured.prompt.captured, true)
  assert.equal(captured.prompt.sections.length, 5)
  assert.equal(captured.prompt.sections.find((row) => row.name === 'tool:bash').readOnly, true)
  assert.equal(captured.prompt.sections.find((row) => row.name === 'plan:policy').readOnly, false)
  assert.deepEqual(captured.prompt.delta, { firstCapture: true, added: [], removed: [], version: '0.2.2-rc.3' })
  assert.equal(captured.meta.release.classifiedAgainst, CLASSIFIED_AGAINST)
  assert.equal(captured.meta.lastCapture.names.length, 5)

  // 3. disabled: saving a fragment stores it but does not shadow the prompt
  await api.handle({ op: 'fragment.save', sessionId: sid, key: 'tool:bash', mode: 'replace', text: 'never run bash' })
  assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).sections[2].text, 'run bash carefully')

  // 4. enable -> registration happens through agent.ctx.systemPrompt.section()
  const enabled = await api.handle({ op: 'session.set', sessionId: sid, enabled: true })
  assert.equal(enabled.session.enabled, true)
  const rewritten = await agent.ctx.systemPrompt.assemble({ agent, scope: agent })
  assert.deepEqual(names(rewritten), [
    'harness:identity', 'plan:policy', 'tool:bash', 'tool:read', 'acme:plugin-section'
  ])
  assert.equal(rewritten.sections[2].text, 'never run bash')

  const bashRow = (await api.handle({ op: 'state.get', sessionId: sid })).prompt.sections.find((row) => row.name === 'tool:bash')
  assert.equal(bashRow.status, 'active')
  assert.equal(bashRow.source, 'official')
  assert.equal(bashRow.sensitivity, 'capability')
  const identityRow = (await api.handle({ op: 'state.get', sessionId: sid })).prompt.sections.find((row) => row.name === 'harness:identity')
  assert.equal(identityRow.sensitivity, 'persona')
  const pluginRow = (await api.handle({ op: 'state.get', sessionId: sid })).prompt.sections.find((row) => row.name.startsWith('acme:'))
  assert.equal(pluginRow.source, 'plugin')
  assert.equal(pluginRow.sensitivity, null)

  // 5. auto backup exists and a manual backup is tracked separately
  await api.handle({ op: 'backup.create', sessionId: sid, label: 'mine' })
  const backups = (await api.handle({ op: 'state.get', sessionId: sid })).backups
  assert.ok(backups.auto.length > 0)
  assert.equal(backups.manual.length, 1)
  assert.equal(backups.manual[0].version, 3)
  const restoredBackup = await api.handle({ op: 'backup.restore', sessionId: sid, file: backups.manual[0].file })
  assert.equal(restoredBackup.restored.version, 3)
  assert.equal(typeof restoredBackup.restored.mapped, 'number')
  assert.ok((await api.handle({ op: 'state.get', sessionId: sid })).prompt.sections.some((row) => row.status === 'active'))

  // 6. drift: a fresh capture sees the new official text and suspends the pin
  agent.setText('tool:bash', 'run bash carefully (new official text)')
  const drifted = await api.handle({ op: 'assemble.capture', sessionId: sid })
  assert.equal(drifted.prompt.sections.find((row) => row.name === 'tool:bash').status, 'suspended')
  assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).sections[2].text, 'run bash carefully (new official text)')

  // 7. rebase re-pins and the override is installed again
  await api.handle({ op: 'fragment.rebase', sessionId: sid, key: 'tool:bash' })
  assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).sections[2].text, 'never run bash')

  // 8. empty mode removes the section text
  await api.handle({ op: 'fragment.save', sessionId: sid, key: 'tool:read', mode: 'empty', text: '' })
  assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).sections[3].text, '')

  // 9. anchored extras keep the panel order and the assembled order identical
  await api.handle({ op: 'extra.save', sessionId: sid, name: 'custom:middle', anchor: 'tool:bash', order: 10, text: 'MID' })
  await api.handle({ op: 'extra.save', sessionId: sid, name: 'custom:tail', anchor: '__end__', order: 20, text: 'TAIL' })
  const rowsOf = () => engine.describe(sid).sections.map((row) => row.name)
  assert.deepEqual(rowsOf(), [
    'harness:identity', 'plan:policy', 'tool:bash', 'custom:middle', 'tool:read',
    'acme:plugin-section', 'custom:tail'
  ])
  assert.deepEqual(names(await agent.ctx.systemPrompt.assemble({ agent, scope: agent })), rowsOf())

  const middle = engine.describe(sid).sections.find((row) => row.name === 'custom:middle')
  await api.handle({ op: 'extra.move', sessionId: sid, id: middle.extraId, delta: -1 })
  assert.deepEqual(rowsOf(), [
    'harness:identity', 'plan:policy', 'custom:middle', 'tool:bash', 'tool:read',
    'acme:plugin-section', 'custom:tail'
  ])
  await api.handle({ op: 'extra.move', sessionId: sid, id: middle.extraId, delta: 1 })
  assert.deepEqual(rowsOf(), [
    'harness:identity', 'plan:policy', 'tool:bash', 'custom:middle', 'tool:read',
    'acme:plugin-section', 'custom:tail'
  ])
  assert.deepEqual(names(await agent.ctx.systemPrompt.assemble({ agent, scope: agent })), rowsOf())

  // edge moves are silent no-ops
  const tail = engine.describe(sid).sections.find((row) => row.name === 'custom:tail')
  const beforeEdge = JSON.stringify(rowsOf())
  await api.handle({ op: 'extra.move', sessionId: sid, id: tail.extraId, delta: 1 })
  assert.equal(JSON.stringify(rowsOf()), beforeEdge)

  // editing an existing user section updates state.extras and maps it to a
  // section text entry (P6: extras are references, not private text copies)
  await api.handle({ op: 'extra.save', sessionId: sid, name: 'custom:middle', anchor: 'tool:bash', order: 10, text: 'MID edited' })
  assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).sections[3].text, 'MID edited')
  const middleEntry = store.library().fragments.find((fragment) =>
    fragment.target === 'insert' && fragment.key === 'custom:middle' && fragment.text === 'MID edited')
  assert.ok(middleEntry)
  assert.equal(store.state(sid).extras.find((extra) => extra.name === 'custom:middle').textId, middleEntry.id)
  assert.equal(engine.describe(sid).sections.find((row) => row.name === 'custom:middle').textId, middleEntry.id)

  // 10. orphan: a saved name that the assembly no longer has is not registered
  await api.handle({ op: 'fragment.save', sessionId: sid, key: 'plan:missing', mode: 'replace', text: 'x' })
  const orphan = (await api.handle({ op: 'state.get', sessionId: sid })).prompt.sections.find((row) => row.name === 'plan:missing')
  assert.equal(orphan.status, 'orphan')
  assert.ok(!names(await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).includes('plan:missing'))

  // 11. capture delta reports added/removed names, not content changes
  agent.sections.push({ name: 'plugin:new-section', order: 4000, text: 'new' })
  const afterAdd = await api.handle({ op: 'assemble.capture', sessionId: sid })
  assert.deepEqual(afterAdd.prompt.delta.added, ['plugin:new-section'])
  assert.deepEqual(afterAdd.prompt.delta.removed, [])
  assert.equal(afterAdd.meta.lastCapture.names.includes('plugin:new-section'), true)

  // 12. complete preset: detected, never overridden, and reported as blocked
  const completeSid = 'session-complete-1'
  const completeAgent = createAgent(completeSid, [
    { name: 'harness:identity', order: -1000, text: 'you are dsh' },
    { name: 'preset:complete', order: 0, text: 'WHOLE PROMPT', complete: true }
  ])
  live.set(completeSid, completeAgent)
  await api.handle({ op: 'session.set', sessionId: completeSid, enabled: true })
  const completeCapture = await api.handle({ op: 'assemble.capture', sessionId: completeSid })
  assert.equal(completeCapture.prompt.completeActive, true)
  assert.equal(completeCapture.prompt.complete.active, true)
  assert.equal(completeCapture.prompt.complete.sectionName, 'preset:complete')
  assert.equal(completeCapture.prompt.complete.text, 'WHOLE PROMPT')
  assert.equal(completeCapture.prompt.complete.presetId, 'minimal')
  assert.equal(completeCapture.prompt.complete.presetName, 'Minimal')
  assert.equal(completeCapture.meta.completeActive, true)
  await api.handle({ op: 'fragment.save', sessionId: completeSid, key: 'harness:identity', mode: 'replace', text: 'hacked' })
  const completeAssembly = await completeAgent.ctx.systemPrompt.assemble({ agent: completeAgent, scope: completeAgent })
  assert.deepEqual(names(completeAssembly), ['preset:complete'])
  assert.equal(completeAssembly.sections[0].text, 'WHOLE PROMPT')
  const blocked = (await api.handle({ op: 'state.get', sessionId: completeSid })).prompt.sections.find((row) => row.name === 'harness:identity')
  assert.equal(blocked.status, 'blocked')
  const completeLibrary = await api.handle({ op: 'library.list', sessionId: completeSid })
  assert.equal(completeLibrary.completeActive, true)
  const completeFragment = completeLibrary.fragments.find((fragment) => fragment.key === 'harness:identity')
  assert.equal(completeFragment.orphan, null)
  assert.equal(completeFragment.blocked, true)
  await api.handle({ op: 'preset.capture', sessionId: completeSid, name: 'complete-p1' })
  const completePresetState = await api.handle({ op: 'state.get', sessionId: completeSid })
  assert.equal(completePresetState.session.presetStats.blocked, 1)
  assert.equal(completePresetState.session.presetStats.orphan, 0)
  const completePresetId = completePresetState.presets.find((preset) => preset.name === 'complete-p1').id
  await api.handle({ op: 'preset.delete', sessionId: completeSid, id: completePresetId, force: true })

  // 13. registry-introspection fallback: unknown order is calibrated with probes
  const calibrateSid = 'session-calibrate-1'
  const calibrateAgent = createAgent('session-calibrate-1', [
    { name: 'harness:identity', order: -1000, text: 'identity' },
    { name: 'hidden:unknown', order: 2711.5, text: 'unknown text' },
    { name: 'tool:bash', order: 1000, text: 'bash' }
  ], { hideLayers: true })
  live.set(calibrateSid, calibrateAgent)
  await api.handle({ op: 'session.set', sessionId: calibrateSid, enabled: true })
  await api.handle({ op: 'assemble.capture', sessionId: calibrateSid })
  await api.handle({ op: 'fragment.save', sessionId: calibrateSid, key: 'hidden:unknown', mode: 'replace', text: 'calibrated override' })
  const calibrated = await calibrateAgent.ctx.systemPrompt.assemble({ agent: calibrateAgent, scope: calibrateAgent })
  assert.deepEqual(calibrated.sections.map((section) => section.name), ['harness:identity', 'tool:bash', 'hidden:unknown'])
  assert.equal(calibrated.sections[2].text, 'calibrated override')

  // 14. fragment library: usage, orphan, presets, cascade delete
  const secondSid = 'session-test-2'
  const secondAgent = createAgent(secondSid, officialSections())
  live.set(secondSid, secondAgent)
  await api.handle({ op: 'assemble.capture', sessionId: secondSid })
  await api.handle({ op: 'session.set', sessionId: secondSid, enabled: true })
  await api.handle({ op: 'fragment.save', sessionId: secondSid, key: 'tool:bash', mode: 'replace', text: 'shared override' })

  const library = await api.handle({ op: 'library.list', sessionId: sid })
  const sidBash = library.fragments.find((fragment) =>
    fragment.key === 'tool:bash' && fragment.usage.sessions.some((entry) => entry.id === sid))
  assert.ok(sidBash !== undefined)
  // Map the second session to the same template explicitly, so this test
  // exercises shared usage under the multi-template model.
  await api.handle({
    op: 'fragment.save',
    sessionId: secondSid,
    key: 'tool:bash',
    mode: 'replace',
    text: 'sid-only shared',
    id: sidBash.id
  })
  const libraryShared = await api.handle({ op: 'library.list', sessionId: sid })
  const bashFragment = libraryShared.fragments.find((fragment) => fragment.id === sidBash.id)
  assert.ok(bashFragment.usage.sessions.some((entry) => entry.id === sid))
  assert.ok(bashFragment.usage.sessions.some((entry) => entry.id === secondSid))
  assert.equal(bashFragment.orphan, false)
  const missingFragment = libraryShared.fragments.find((fragment) => fragment.key === 'plan:missing')
  assert.equal(missingFragment.orphan, true)

  // no-op save does not bump updatedAt or create a new template
  const beforeNoop = bashFragment.updatedAt
  const noop = await api.handle({
    op: 'fragment.save',
    sessionId: sid,
    key: 'tool:bash',
    mode: 'replace',
    text: 'sid-only shared'
  })
  assert.equal(noop.save.kind, 'unchanged')
  assert.equal(
    (await api.handle({ op: 'library.list', sessionId: sid })).fragments.find((fragment) => fragment.id === bashFragment.id).updatedAt,
    beforeNoop
  )

  // rename only changes the label, not content/updatedAt
  const renamed = await api.handle({ op: 'fragment.rename', sessionId: sid, id: bashFragment.id, label: '共享版' })
  assert.equal(renamed.library.fragments.find((fragment) => fragment.id === bashFragment.id).label, '共享版')

  // a preset may not contain two templates of the same key
  const sameKeyTemplates = libraryShared.fragments.filter((fragment) => fragment.key === 'tool:bash')
  assert.ok(sameKeyTemplates.length >= 2)
  await assert.rejects(() => api.handle({
    op: 'preset.save',
    sessionId: sid,
    preset: {
      name: 'duplicate-key',
      fragmentIds: sameKeyTemplates.slice(0, 2).map((fragment) => fragment.id)
    }
  }))

  await assert.rejects(() => api.handle({ op: 'fragment.delete', sessionId: sid, id: bashFragment.id }))
  const cascade = await api.handle({ op: 'fragment.delete', sessionId: sid, id: bashFragment.id, cascade: true })
  assert.ok(cascade.deleted.sessions.some((entry) => entry.id === secondSid))
  assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).sections[2].text, 'run bash carefully (new official text)')

  // 15. preset limit, apply, stats
  settings.presetLimit = 2
  await api.handle({ op: 'preset.capture', sessionId: sid, name: 'p1' })
  await api.handle({ op: 'preset.capture', sessionId: sid, name: 'p2' })
  await assert.rejects(() => api.handle({ op: 'preset.capture', sessionId: sid, name: 'p3' }))
  const presetId = (await api.handle({ op: 'state.get', sessionId: sid })).presets[0].id
  await api.handle({ op: 'session.reset', sessionId: sid })
  const applied = await api.handle({ op: 'preset.apply', sessionId: sid, id: presetId })
  assert.ok(applied.applied.stats.total > 0)
  assert.equal(applied.session.lastPreset.id, presetId)
  assert.equal(applied.session.currentPreset.source, 'preset')
  assert.equal(applied.session.currentPreset.modified, false)

  // Deleting the applied preset must not leave a dangling source or break the
  // prompt page. The current configuration stays, but is reported as manual.
  const afterPresetDelete = await api.handle({ op: 'preset.delete', sessionId: sid, id: presetId, force: true })
  assert.equal(afterPresetDelete.session.lastPreset, null)
  assert.equal(afterPresetDelete.session.currentPreset.source, 'manual')
  assert.equal(afterPresetDelete.session.currentPreset.exists, false)
  assert.equal(afterPresetDelete.session.currentPreset.modified, false)
  assert.ok(Array.isArray(afterPresetDelete.prompt.sections))
  assert.ok(afterPresetDelete.prompt.sections.length > 0)

  // Saving an unchanged (empty) configuration as a preset and deleting it again
  // must return to "not set", not "modified".
  const blankSid = 'session-blank-preset-1'
  const blankAgent = createAgent(blankSid, officialSections())
  live.set(blankSid, blankAgent)
  await api.handle({ op: 'session.set', sessionId: blankSid, enabled: true })
  await api.handle({ op: 'assemble.capture', sessionId: blankSid })
  await api.handle({ op: 'preset.capture', sessionId: blankSid, name: 'empty-p1' })
  const blankState = await api.handle({ op: 'state.get', sessionId: blankSid })
  const blankPresetId = blankState.presets.find((preset) => preset.name === 'empty-p1').id
  await api.handle({ op: 'preset.delete', sessionId: blankSid, id: blankPresetId, force: true })
  const afterBlank = await api.handle({ op: 'state.get', sessionId: blankSid })
  assert.equal(afterBlank.session.currentPreset.source, 'none')
  assert.equal(afterBlank.session.currentPreset.modified, false)
  assert.equal(afterBlank.session.currentPreset.overrideCount, 0)

  // "Restore default configuration" clears the current preset and returns the
  // session to the untouched state.
  const resetState = await api.handle({ op: 'session.reset', sessionId: sid })
  assert.equal(resetState.session.currentPreset.source, 'none')
  assert.equal(resetState.session.currentPreset.modified, false)
  assert.equal(resetState.session.currentPreset.overrideCount, 0)

  // Saving the official text unchanged is a no-op; two templates for the same
  // key become possible through an explicit "new" save.
  const newSid = 'session-multi-template-1'
  const newAgent = createAgent(newSid, officialSections())
  live.set(newSid, newAgent)
  await api.handle({ op: 'session.set', sessionId: newSid, enabled: true })
  await api.handle({ op: 'assemble.capture', sessionId: newSid })
  const beforeNoopLibrary = await api.handle({ op: 'library.list', sessionId: newSid })
  const officialNoop = await api.handle({
    op: 'fragment.save',
    sessionId: newSid,
    key: 'tool:bash',
    mode: 'replace',
    text: 'run bash carefully'
  })
  assert.equal(officialNoop.save.kind, 'unchanged')
  const afterNoopLibrary = await api.handle({ op: 'library.list', sessionId: newSid })
  assert.equal(afterNoopLibrary.fragments.length, beforeNoopLibrary.fragments.length)
  assert.equal((await api.handle({ op: 'state.get', sessionId: newSid })).prompt.sections.find((row) => row.name === 'tool:bash').status, 'official')

  const firstTemplate = await api.handle({
    op: 'fragment.save',
    sessionId: newSid,
    key: 'tool:bash',
    mode: 'replace',
    text: 'first template'
  })
  assert.equal(firstTemplate.save.kind, 'created')
  const secondTemplate = await api.handle({
    op: 'fragment.save',
    sessionId: newSid,
    key: 'tool:bash',
    mode: 'replace',
    text: 'second template',
    new: true,
    label: '第二模板'
  })
  assert.equal(secondTemplate.save.kind, 'created')
  // Direct saves without an explicit label get the next unused auto label.
  const labelLibrary = await api.handle({ op: 'library.list', sessionId: newSid })
  const usedLabels = new Set(labelLibrary.fragments.map((fragment) => fragment.label))
  const expectedAutoLabels = []
  for (let index = 0; index < 2; index++) {
    let candidate = '默认'
    let suffix = 1
    while (usedLabels.has(candidate)) {
      candidate = `默认${suffix}`
      suffix += 1
    }
    usedLabels.add(candidate)
    expectedAutoLabels.push(candidate)
  }
  await api.handle({
    op: 'fragment.save',
    sessionId: newSid,
    key: 'tool:bash',
    mode: 'replace',
    text: 'third template',
    new: true
  })
  await api.handle({
    op: 'fragment.save',
    sessionId: newSid,
    key: 'tool:bash',
    mode: 'replace',
    text: 'fourth template',
    new: true
  })
  const multiLibrary = await api.handle({ op: 'library.list', sessionId: newSid })
  const bashGroup = multiLibrary.groups.find((group) => group.key === 'tool:bash')
  assert.ok(bashGroup.templateCount >= 4)
  assert.ok(bashGroup.templates.some((fragment) => fragment.label === '第二模板'))
  const autoLabels = bashGroup.templates.map((fragment) => fragment.label)
  for (const expected of expectedAutoLabels) assert.ok(autoLabels.includes(expected), `missing ${expected}`)
  assert.equal(new Set(autoLabels).size, autoLabels.length, 'auto labels must be unique inside the group')
  assert.equal(bashGroup.readOnly, true)
  assert.equal(bashGroup.templates.every((fragment) => fragment.readOnly === true), true)

  // Groups follow the official assembly order, not the key's dictionary order.
  // "deployment:persona-prefix" sorts before "harness:identity" alphabetically,
  // but the official order places identity first.
  const orderSid = 'session-group-order-1'
  const orderAgent = createAgent(orderSid, [
    { name: 'harness:identity', order: -1000, text: 'identity' },
    { name: 'deployment:persona-prefix', order: 0, text: 'persona prefix' },
    { name: 'tool:bash', order: 1000, text: 'bash' }
  ])
  live.set(orderSid, orderAgent)
  await api.handle({ op: 'session.set', sessionId: orderSid, enabled: true })
  await api.handle({ op: 'assemble.capture', sessionId: orderSid })
  await api.handle({ op: 'fragment.save', sessionId: orderSid, key: 'harness:identity', mode: 'replace', text: 'ordered identity' })
  await api.handle({ op: 'fragment.save', sessionId: orderSid, key: 'deployment:persona-prefix', mode: 'replace', text: 'ordered persona' })
  const orderedGroups = (await api.handle({ op: 'library.list', sessionId: orderSid })).groups
  const identityIndex = orderedGroups.findIndex((group) => group.key === 'harness:identity')
  const personaIndex = orderedGroups.findIndex((group) => group.key === 'deployment:persona-prefix')
  assert.ok(identityIndex >= 0 && personaIndex >= 0)
  assert.ok(identityIndex < personaIndex, 'official order must win over key order')

  // 16. config validation and persistence
  await assert.rejects(() => api.handle({ op: 'config.set', presetLimit: 0 }))
  const configured = await api.handle({ op: 'config.set', presetLimit: 3 })
  assert.equal(configured.settings.presetLimit, 3)
  assert.equal(settings.presetLimit, 3)

  // 17. invalid session ids / unknown op are rejected
  await assert.rejects(() => api.handle({ op: 'state.get', sessionId: '../escape' }))
  await assert.rejects(() => api.handle({ op: 'nope', sessionId: sid }))

  // 18. corrupt state file degrades instead of throwing
  fs.writeFileSync(path.join(dir, 'sessions', sid, 'state.json'), '{not json')
  assert.doesNotThrow(() => engine.describe(sid))
  assert.doesNotThrow(() => engine.sync(sid))

  // 19. detached agent loses its registrations
  engine.detach(calibrateSid)
  assert.equal(engine.describe(calibrateSid).captured, false)

  // 20. v3 storage foundation: library migration, multi-template helpers,
  // draft overlay, and session liveness classification.
  const migrateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-v1-'))
  fs.mkdirSync(path.join(migrateDir, 'library'), { recursive: true })
  fs.writeFileSync(path.join(migrateDir, 'library', 'sections.json'), JSON.stringify({
    version: 1,
    fragments: [
      { id: 'frag_v1', key: 'tool:bash', mode: 'replace', text: 'old text', baseHash: 'abc', updatedAt: 123 }
    ]
  }), 'utf8')
  const migrateStore = new Store(migrateDir, [], () => settings)
  migrateStore.ensure()
  const migrated = migrateStore.library()
  assert.equal(migrated.version, 3)
  assert.equal(migrated.fragments[0].label, '默认')
  assert.equal(migrated.fragments[0].createdAt, 123)
  assert.equal(migrated.fragments[0].target, 'override')
  assert.equal(migrated.fragments[0].activation, 'persistent')

  const multi = {
    version: 2,
    fragments: [
      ...migrated.fragments,
      { id: 'frag_v2', key: 'tool:bash', label: '简洁版', mode: 'empty', text: '', updatedAt: 456 }
    ]
  }
  migrateStore.saveLibrary(multi)
  assert.equal(migrateStore.fragmentsForKey('tool:bash').length, 2)
  assert.equal(migrateStore.fragmentById('frag_v2').label, '简洁版')

  migrateStore.saveDraft('draft-1', {
    state: { enabled: true, overrides: { 'tool:bash': 'frag_v1' } },
    fragments: [
      { id: 'frag_draft_1', key: 'tool:bash', label: '草稿', mode: 'replace', text: 'draft text' }
    ]
  })
  assert.equal(migrateStore.hasDraft('draft-1'), true)
  assert.equal(migrateStore.committed('draft-1'), false)
  assert.equal(migrateStore.stateFor('draft-1').enabled, true)
  assert.equal(migrateStore.isEnabledFor('draft-1'), true)
  assert.equal(migrateStore.libraryFor('draft-1').fragments.length, 3)
  assert.equal(migrateStore.templatesFor('draft-1', 'tool:bash').length, 3)
  migrateStore.deleteDraft('draft-1')
  assert.equal(migrateStore.hasDraft('draft-1'), false)

  const liveness = await classifySessions(
    ['live-1', 'archived-1', 'saved-1', 'missing-1'],
    {
      sessions: { get: (id) => (id === 'live-1' ? { id } : undefined) },
      workspaceRegistry: { archivedSessionIds: ['archived-1'] },
      sessionPersistence: { list: async () => [{ header: { id: 'saved-1' } }] },
      sessionTitle: { get: () => ({ title: 'Live title' }) }
    }
  )
  assert.equal(liveness.get('live-1').status, 'live')
  assert.equal(liveness.get('live-1').title, 'Live title')
  assert.equal(liveness.get('archived-1').status, 'archived')
  assert.equal(liveness.get('saved-1').status, 'saved')
  assert.equal(liveness.get('missing-1').status, 'missing')
  const unknownLiveness = await classifySessions(['x'], {
    sessionPersistence: { list: async () => { throw new Error('persistence unavailable') } }
  })
  assert.equal(unknownLiveness.get('x').status, 'unknown')

  // 21. engine sees the draft overlay without writing formal state.
  const draftSid = 'session-draft-engine-1'
  const draftAgent = createAgent(draftSid, officialSections())
  store.saveDraft(draftSid, {
    state: { enabled: true, overrides: { 'tool:bash': 'frag_draft_test' } },
    fragments: [
      { id: 'frag_draft_test', key: 'tool:bash', label: '草稿模板', mode: 'replace', text: 'draft override' }
    ]
  })
  const draftAttach = await engine.attach(draftAgent)
  assert.equal(draftAttach.ok, true)
  const draftAssembly = await draftAgent.ctx.systemPrompt.assemble({ agent: draftAgent, scope: draftAgent })
  assert.equal(draftAssembly.sections[2].text, 'draft override')
  assert.equal(store.hasDraft(draftSid), true)
  assert.equal(fs.existsSync(path.join(dir, 'sessions', draftSid, 'state.json')), false)
  engine.detach(draftSid)
  store.deleteDraft(draftSid)

  // Read-only cleanup: presets, session overrides/extras, drafts, and backups
  // must not retain mappings to tool/capability protocol sections.
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-clean-'))
  const cleanStore = new Store(cleanDir, [], () => settings)
  cleanStore.ensure()
  cleanStore.saveLibrary({
    version: 2,
    fragments: [
      { id: 'ro_tool', key: 'tool:bash', label: 'tool', mode: 'replace', text: 'tool text' },
      { id: 'ok_identity', key: 'harness:identity', label: 'identity', mode: 'replace', text: 'identity text' }
    ]
  })
  cleanStore.savePresets({
    version: 3,
    presets: [{
      version: 3,
      id: 'preset_ro',
      name: 'ro',
      fragmentIds: ['ro_tool', 'ok_identity'],
      extras: [],
      transientSections: [],
      toolPolicy: { allow: null, deny: [] },
      updatedAt: Date.now()
    }]
  })
  const cleanState = cleanStore.state('session-clean-1')
  cleanStore.saveState('session-clean-1', {
    ...cleanState,
    overrides: { 'tool:bash': 'ro_tool', 'harness:identity': 'ok_identity' },
    extras: [{ id: 'extra_ro', name: 'tool:extra', anchor: '__end__', order: 0, text: 'x' }]
  })
  const backupEntry = cleanStore.backup('session-clean-1', 'before cleanup', 'manual')
  const backupPayload = cleanStore.readBackup('session-clean-1', backupEntry.file)
  assert.equal(backupPayload.session.prompt.overrides['tool:bash'], undefined)
  assert.equal(backupPayload.session.prompt.overrides['harness:identity'], 'ok_identity')
  assert.equal(backupPayload.session.prompt.extras.length, 0)

  cleanStore.saveDraft('session-clean-1', {
    state: { enabled: true, overrides: { 'tool:bash': 'ro_tool', 'harness:identity': 'ok_identity' } },
    fragments: [{ id: 'draft_ro', key: 'tool:bash', label: 'draft tool', mode: 'replace', text: 'draft' }]
  })
  const cleaned = cleanStore.sanitizeReadOnly()
  assert.equal(cleaned.presets, 1)
  assert.equal(cleaned.sessions, 1)
  assert.equal(cleaned.drafts, 1)
  assert.deepEqual(cleanStore.presets().presets[0].fragmentIds, ['ok_identity'])
  assert.deepEqual(cleanStore.state('session-clean-1').overrides, { 'harness:identity': 'ok_identity' })
  assert.equal(cleanStore.state('session-clean-1').extras.length, 0)
  const cleanedDraft = cleanStore.draft('session-clean-1')
  assert.deepEqual(cleanedDraft.state.overrides, { 'harness:identity': 'ok_identity' })
  assert.equal(cleanedDraft.fragments.length, 0)

  // PTC-style section providers require the step tool set. A bare probe may
  // throw before the first step; attach retries with the resolved tool set.
  const ptcSid = 'session-ptc-probe'
  const ptcAgent = createAgent(ptcSid, officialSections())
  const originalAssemble = ptcAgent.ctx.systemPrompt.assemble
  let ptcProbeCalls = 0
  ptcAgent.ctx.systemPrompt.assemble = async (context = {}) => {
    ptcProbeCalls += 1
    if (context.toolSet === undefined) throw new Error('ptc sdk requires the step tool set')
    return originalAssemble(context)
  }
  ptcAgent.ctx.tools = {
    async resolve () {
      return { dispose () {}, view () { return new Map() } }
    }
  }
  ptcAgent.model = { current: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) }
  live.set(ptcSid, ptcAgent)
  const ptcAttached = await engine.attach(ptcAgent)
  assert.equal(ptcAttached.ok, true)
  assert.ok(ptcProbeCalls >= 2)

  console.log('all prompt-lab host checks passed')
  console.log('warnings:', warnings.slice(0, 6))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
