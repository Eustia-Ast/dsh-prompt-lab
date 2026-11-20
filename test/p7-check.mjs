/**
 * P7 preset/backup checks.
 *
 * Presets store the full session configuration (official overrides, extras,
 * transient sections, tool policy). Backups store the same session config but
 * deliberately do not record the preset page. Old backup formats are ignored.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, emptySession } from '../lib/store.js'
import { createEngine } from '../lib/engine.js'
import { createApi } from '../lib/api.js'

function makePrompt (sections) {
  const scoped = new Map()
  return {
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
      return { HARNESS_IDENTITY: -1000, TOOL_BASH: 1000 }[key]
    },
    async assemble (context = {}) {
      const merged = new Map(sections.map((section) => [section.name, section]))
      for (const [name, definition] of scoped) merged.set(name, definition)
      const definitions = [...merged.values()].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1))
      return {
        sections: definitions.map((definition) => ({
          name: definition.name,
          text: typeof definition.text === 'function' ? definition.text(context) : String(definition.text ?? '')
        })),
        contexts: [],
        tools: [],
        variables: {}
      }
    },
    layers: {
      merge () {
        const merged = new Map(sections.map((section) => [section.name, section]))
        for (const [name, definition] of scoped) merged.set(name, definition)
        return merged
      }
    }
  }
}

function createAgent (id, sections) {
  const prompt = makePrompt(sections)
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
  return { id, session: { id }, ctx, sections }
}

function officialSections () {
  return [
    { name: 'harness:identity', order: -1000, text: 'official identity' },
    { name: 'tool:bash', order: 1000, text: 'bash usage' }
  ]
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-p7-'))
const warnings = []
const settings = { presetLimit: 10, autoBackupLimit: 20, manualBackupLimit: 5 }
const store = new Store(dir, warnings, () => settings)
store.ensure()
const live = new Map()
const draftIds = new Set()
const toolChanges = []
const engine = createEngine({
  store,
  logger: { warn: (message) => warnings.push(message) },
  readOnlySection: () => false,
  isDraftSession: (sessionId) => draftIds.has(sessionId),
  presetOf: () => ({ id: 'default', name: 'Default' })
})
const api = createApi({
  store,
  engine,
  dataDir: dir,
  dataDirSource: 'default',
  warnings,
  agentOf: (sessionId) => live.get(sessionId),
  isPromptLocked: () => false,
  isDraftSession: (sessionId) => draftIds.has(sessionId),
  readOnlySection: () => false,
  livenessOf: async (ids) => new Map(ids.map((id) => [
    id,
    { id, status: live.has(id) ? 'live' : 'missing', title: null }
  ])),
  captureNow: async (sessionId) => {
    const agent = live.get(sessionId)
    if (agent === undefined) return { ok: false, reason: 'not-running' }
    const result = await engine.attach(agent, { force: true })
    return result.ok === true ? { ok: true } : { ok: false, reason: result.reason }
  },
  onToolPolicyChanged: (sessionId) => toolChanges.push(sessionId),
  settings: () => settings,
  saveSettings: (patch) => Object.assign(settings, patch)
})

const sid = 'session-p7-main'
const agent = createAgent(sid, officialSections())
live.set(sid, agent)
await engine.attach(agent)
await api.handle({ op: 'session.set', sessionId: sid, enabled: true })

// ------------------------------------------------ full session configuration
await api.handle({ op: 'fragment.save', sessionId: sid, key: 'harness:identity', mode: 'replace', text: 'override identity' })
await api.handle({ op: 'extra.save', sessionId: sid, name: 'custom:extra', anchor: 'tool:bash', order: 10, text: 'extra text' })
await api.handle({ op: 'tools.set', sessionId: sid, deny: ['bash'] })

let state = store.state(sid)
const extraBefore = state.extras.find((entry) => entry.name === 'custom:extra')
assert.ok(extraBefore.textId)
assert.equal(state.toolPolicy.deny.join(','), 'bash')

// Empty new-section saves are rejected; official "置空" remains a separate mode.
await assert.rejects(
  () => api.handle({ op: 'extra.save', sessionId: sid, name: 'custom:blank', anchor: '__end__', text: '   ' }),
  /不能为空/
)
const captured = await api.handle({ op: 'preset.capture', sessionId: sid, name: 'p7-full' })
const preset = store.presets().presets.find((entry) => entry.name === 'p7-full')
assert.ok(preset)
assert.equal(preset.version, 3)
assert.equal(preset.fragmentIds.length, 1)
assert.equal(preset.extras.length, 1)
assert.equal(preset.transientSections.length, 0)
assert.equal(preset.toolPolicy.deny.join(','), 'bash')
assert.equal(captured.session.currentPreset.source, 'preset')

// ------------------------------------------------ draft apply and full apply
const draftSid = 'session-p7-draft'
draftIds.add(draftSid)
await api.handle({ op: 'preset.apply', sessionId: draftSid, id: preset.id })
assert.equal(store.hasDraft(draftSid), true)
assert.equal(fs.existsSync(path.join(dir, 'sessions', draftSid, 'state.json')), false)
const draftState = store.draft(draftSid).state
assert.equal(draftState.extras.length, 1)
assert.equal(draftState.transientSections.length, 0)
assert.equal(draftState.toolPolicy.deny.join(','), 'bash')

// Reset, then apply the preset to the main session.
await api.handle({ op: 'session.reset', sessionId: sid })
state = store.state(sid)
assert.equal(state.extras.length, 0)
assert.equal(state.transientSections.length, 0)
assert.equal(state.toolPolicy.deny.length, 0)
const applied = await api.handle({ op: 'preset.apply', sessionId: sid, id: preset.id })
assert.equal(applied.applied.overrides, 1)
assert.equal(applied.applied.extras, 1)
assert.equal(applied.applied.transientSections, 0)
assert.equal(applied.applied.toolDeny, 1)
assert.equal(applied.applied.unresolved, 0)
state = store.state(sid)
assert.equal(state.extras[0].textId, extraBefore.textId)
assert.equal(state.toolPolicy.deny.join(','), 'bash')
assert.equal(toolChanges.includes(sid), true)
assert.equal(applied.session.currentPreset.extraCount, 1)
assert.equal(applied.session.currentPreset.transientCount, 0)
assert.equal(applied.session.currentPreset.toolDenyCount, 1)

// ------------------------------------------------------------- backup v3
const backupCreated = await api.handle({ op: 'backup.create', sessionId: sid, label: 'p7 snapshot' })
const payload = store.readBackup(sid, backupCreated.created.file)
assert.equal(payload.version, 3)
assert.equal(payload.presets, undefined)
assert.equal(payload.session.lastPreset, undefined)
assert.equal(payload.session.prompt.extras.length, 1)
assert.equal(payload.session.prompt.transientSections.length, 0)
assert.equal(payload.session.capabilities.toolPolicy.deny.join(','), 'bash')
assert.ok(payload.sectionTexts.length >= 1)

// Mutate, then restore. The preset page is deliberately not restored.
await api.handle({ op: 'session.reset', sessionId: sid })
const restored = await api.handle({ op: 'backup.restore', sessionId: sid, file: backupCreated.created.file })
assert.equal(restored.restored.version, 3)
state = store.state(sid)
assert.equal(state.extras.length, 1)
assert.equal(state.transientSections.length, 0)
assert.equal(state.toolPolicy.deny.join(','), 'bash')
assert.equal(state.lastPreset, null)
assert.equal(state.presetModified, false)
assert.equal(restored.session.currentPreset.source, 'manual')

// Old backup formats are invisible and rejected.
const oldFile = '2000-01-01T00-00-00-000Z-manual-old.json'
fs.writeFileSync(path.join(store.sessionDir(sid), 'backups', oldFile), JSON.stringify({
  version: 2,
  currentPreset: { overrides: {} }
}))
const listed = await api.handle({ op: 'state.get', sessionId: sid })
assert.equal([...listed.backups.manual, ...listed.backups.auto].some((entry) => entry.file === oldFile), false)
await assert.rejects(
  () => api.handle({ op: 'backup.restore', sessionId: sid, file: oldFile }),
  /旧版备份/
)

// ------------------------------------------- text reference deleted from preset
const extraTextId = state.extras[0].textId
await api.handle({ op: 'fragment.delete', sessionId: sid, id: extraTextId, cascade: true })
const presetAfterDelete = store.presets().presets.find((entry) => entry.id === preset.id)
assert.ok(!presetAfterDelete.extras.some((entry) => entry.textId === extraTextId))
const missing = await api.handle({ op: 'preset.apply', sessionId: sid, id: preset.id })
assert.equal(missing.applied.unresolved, 0)
state = store.state(sid)
assert.ok(!state.extras.some((entry) => entry.name === 'custom:extra'))
assert.equal(state.transientSections.length, 0)

// --------------------------------------------------- preset usage/delete
const usage = await api.handle({ op: 'preset.usage', id: preset.id })
assert.ok(usage.count >= 2)
assert.ok(usage.sessions.some((entry) => entry.id === draftSid && entry.draft === true))
await assert.rejects(
  () => api.handle({ op: 'preset.delete', sessionId: sid, id: preset.id }),
  /仍被/
)
const deleted = await api.handle({ op: 'preset.delete', sessionId: sid, id: preset.id, force: true })
assert.equal(deleted.deleted.name, 'p7-full')
assert.ok(deleted.deleted.usage.count >= 2)
assert.equal(store.presets().presets.some((entry) => entry.id === preset.id), false)
assert.equal(store.state(sid).lastPreset, null)

// Old preset entries are ignored by the v3 loader.
const oldPresets = {
  version: 1,
  presets: [{ id: 'old', name: 'old', fragmentIds: [] }]
}
store.savePresets(oldPresets)
assert.equal(store.presets().presets.length, 0)

// Read-only assembly overview: summaries only, no state mutation.
const beforeOverview = JSON.stringify(store.state(sid))
const overview = await api.handle({ op: 'assembly.overview', sessionId: sid })
assert.equal(overview.completeActive, false)
assert.equal(typeof overview.systemPrompt.sectionCount, 'number')
assert.equal(typeof overview.systemPrompt.tokens, 'number')
assert.equal(typeof overview.tools.count, 'number')
assert.equal(overview.runtimeContext.available, false)
assert.equal(overview.currentInput.available, false)
assert.equal(JSON.stringify(store.state(sid)), beforeOverview)

console.log('P7 checks passed')
console.log('warnings:', warnings)
