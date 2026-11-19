/**
 * Draft-session lifecycle checks.
 *
 * A blank window (no turn yet) must keep edits in `drafts/<id>.json`; the
 * first turn commits them to `sessions/<id>/state.json` and to the global
 * fragment library, writing the first automatic backup. This file exercises
 * the Store/API contract directly, without the Cordis lifecycle wiring.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../lib/store.js'
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
  return { id, session: { id }, ctx }
}

function sections () {
  return [
    { name: 'harness:identity', order: -1000, text: 'official identity' },
    { name: 'tool:bash', order: 1000, text: 'bash usage' }
  ]
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-draft-'))
const warnings = []
const settings = { presetLimit: 10, autoBackupLimit: 20, manualBackupLimit: 5 }
const store = new Store(dir, warnings, () => settings, { isReadOnlySection: () => false })
store.ensure()
const engine = createEngine({
  store,
  logger: { warn: (message) => warnings.push(message) },
  readOnlySection: () => false,
  isDraftSession: (sessionId) => draftIds.has(sessionId),
  presetOf: () => ({ id: 'default', name: 'Default' })
})
const live = new Map()
const draftIds = new Set()
const api = createApi({
  store,
  engine,
  dataDir: dir,
  dataDirSource: 'default',
  warnings,
  agentOf: (sessionId) => live.get(sessionId),
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
    return result.ok === true
      ? { ok: true, sections: engine.describe(sessionId).sections.length }
      : { ok: false, reason: result.reason }
  },
  settings: () => settings,
  saveSettings: (patch) => Object.assign(settings, patch)
})

const draftSid = 'session-draft-1'
const agent = createAgent(draftSid, sections())
live.set(draftSid, agent)
draftIds.add(draftSid)

const original = await api.handle({ op: 'assemble.capture', sessionId: draftSid })
assert.equal(original.capture.ok, true)
assert.equal(fs.existsSync(path.join(dir, 'sessions', draftSid, 'state.json')), false)

// Saving the official text unchanged is a no-op and must not create a draft.
const draftNoop = await api.handle({
  op: 'fragment.save',
  sessionId: draftSid,
  key: 'harness:identity',
  mode: 'replace',
  text: 'official identity'
})
assert.equal(draftNoop.save.kind, 'unchanged')
assert.equal(fs.existsSync(path.join(dir, 'drafts', `${draftSid}.json`)), false)

// Enabling a blank window writes `drafts/<id>.json`, never formal state.
const enabled = await api.handle({ op: 'session.set', sessionId: draftSid, enabled: true })
assert.equal(enabled.session.enabled, true)
assert.equal(enabled.session.draft, true)
assert.equal(enabled.session.committed, false)
assert.equal(fs.existsSync(path.join(dir, 'drafts', `${draftSid}.json`)), true)
assert.equal(fs.existsSync(path.join(dir, 'sessions', draftSid, 'state.json')), false)
assert.equal(store.library().fragments.length, 0)

// A template created in a blank window enters the GLOBAL library immediately;
// only the mapping stays in the draft.
const saved = await api.handle({
  op: 'fragment.save',
  sessionId: draftSid,
  key: 'harness:identity',
  mode: 'replace',
  text: 'draft identity'
})
assert.equal(saved.save.kind, 'created')
assert.ok(saved.save.fragmentId.startsWith('frag_'))
assert.equal(fs.existsSync(path.join(dir, 'sessions', draftSid, 'state.json')), false)
assert.equal(store.library().fragments.length, 1)
assert.equal(store.draft(draftSid).fragments.length, 0)
assert.equal(store.listBackups(draftSid).length, 0)
assert.equal(saved.session.draft, true)
assert.equal(saved.library.fragments.find((fragment) => fragment.id === saved.save.fragmentId).draft, false)
assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).sections[0].text, 'draft identity')

// Saving identical content maps instead of creating another template.
const mapped = await api.handle({
  op: 'fragment.save',
  sessionId: draftSid,
  key: 'harness:identity',
  mode: 'replace',
  text: 'draft identity',
  new: true,
  label: 'duplicate'
})
assert.ok(['mapped', 'unchanged'].includes(mapped.save.kind))
assert.equal(mapped.save.fragmentId, saved.save.fragmentId)
assert.equal(store.library().fragments.length, 1)

// Saving a global preset is a global change and is allowed from a draft; the
// current-window source (`lastPreset`) is still written to the draft state.
const draftPreset = await api.handle({ op: 'preset.capture', sessionId: draftSid, name: 'draft-captured-preset' })
const capturedPreset = draftPreset.presets.find((preset) => preset.name === 'draft-captured-preset')
assert.ok(capturedPreset !== undefined)
assert.equal(capturedPreset.fragmentIds.length, 1)
assert.equal(draftPreset.session.lastPreset.id, capturedPreset.id)
assert.equal(draftPreset.session.draft, true)
assert.equal(store.hasDraft(draftSid), true)
assert.equal(fs.existsSync(path.join(dir, 'sessions', draftSid, 'state.json')), false)
const savedPreset = await api.handle({
  op: 'preset.save',
  sessionId: draftSid,
  preset: { name: 'saved-from-draft' }
})
assert.ok(savedPreset.presets.some((preset) => preset.name === 'saved-from-draft'))
assert.equal(savedPreset.session.draft, true)

// Backups stay session-level and are unavailable until the draft commits.
await assert.rejects(
  () => api.handle({ op: 'backup.create', sessionId: draftSid, label: 'nope' }),
  /草稿/
)
await assert.rejects(
  () => api.handle({ op: 'backup.restore', sessionId: draftSid, file: 'nope.json' }),
  /草稿/
)

// The global library lists the template, but the draft mapping is not counted
// as a committed session reference.
const globalLibrary = await api.handle({ op: 'library.list', sessionId: draftSid })
const draftTemplate = globalLibrary.fragments.find((fragment) => fragment.preview === 'draft identity')
assert.ok(draftTemplate !== undefined)
assert.equal(draftTemplate.usage.sessions.length, 0)
assert.deepEqual(draftTemplate.usage.presets, ['draft-captured-preset'])

// Commitment writes formal state + first backup and deletes the draft; the
// template was already global, so no library merge is needed.
const described = engine.describe(draftSid)
const committed = store.commitDraft(draftSid, {
  captureOf: (key) => {
    const row = described.sections.find((section) => section.name === key)
    return row === undefined ? null : { officialHash: row.officialHash, officialText: row.officialText }
  }
})
assert.equal(committed.committed, true)
assert.equal(committed.created, 0)
assert.equal(store.hasDraft(draftSid), false)
assert.equal(fs.existsSync(path.join(dir, 'sessions', draftSid, 'state.json')), true)
assert.equal(store.library().fragments.length, 1)
assert.equal(store.library().fragments[0].text, 'draft identity')
assert.ok(store.listBackups(draftSid).some((entry) => entry.kind === 'auto'))
engine.sync(draftSid)
assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).sections[0].text, 'draft identity')
const after = await api.handle({ op: 'state.get', sessionId: draftSid })
assert.equal(after.session.draft, false)
assert.equal(after.session.committed, true)
assert.equal(after.session.enabled, true)

// Editing a global template from a blank window is also a global change: the
// shared template is updated in place, while the mapping stays in the draft.
const copySid = 'session-draft-copy'
const copyAgent = createAgent(copySid, sections())
live.set(copySid, copyAgent)
draftIds.add(copySid)
await api.handle({ op: 'assemble.capture', sessionId: copySid })
const globalTemplate = store.library().fragments.find((fragment) => fragment.text === 'draft identity')
assert.ok(globalTemplate !== undefined)
const mappedGlobal = await api.handle({
  op: 'fragment.save',
  sessionId: copySid,
  key: 'harness:identity',
  mode: 'replace',
  text: 'draft identity',
  id: globalTemplate.id
})
assert.equal(mappedGlobal.save.fragmentId, globalTemplate.id)
assert.equal(store.draft(copySid).fragments.length, 0)
const editedDraft = await api.handle({
  op: 'fragment.save',
  sessionId: copySid,
  key: 'harness:identity',
  mode: 'replace',
  text: 'globally edited in draft'
})
assert.equal(editedDraft.save.kind, 'updated')
assert.equal(editedDraft.save.fragmentId, globalTemplate.id)
assert.equal(store.library().fragments.find((fragment) => fragment.id === globalTemplate.id).text, 'globally edited in draft')
assert.equal(store.draft(copySid).fragments.length, 0)
assert.equal(store.draft(copySid).state.overrides['harness:identity'], globalTemplate.id)

// A discarded blank window must not remove a template it added: templates are
// global, only the mapping disappears with the draft.
const discardSid = 'session-draft-discard'
const discardAgent = createAgent(discardSid, sections())
live.set(discardSid, discardAgent)
draftIds.add(discardSid)
await api.handle({ op: 'session.set', sessionId: discardSid, enabled: true })
const discardSaved = await api.handle({
  op: 'fragment.save',
  sessionId: discardSid,
  key: 'harness:identity',
  mode: 'replace',
  text: 'global from discarded draft'
})
assert.equal(discardSaved.save.kind, 'created')
assert.equal(store.library().fragments.some((fragment) => fragment.text === 'global from discarded draft'), true)
store.deleteDraft(discardSid)
assert.equal(store.hasDraft(discardSid), false)
assert.equal(store.library().fragments.some((fragment) => fragment.text === 'global from discarded draft'), true)

const copyDescribed = engine.describe(copySid)
const copied = store.commitDraft(copySid, {
  captureOf: (key) => {
    const row = copyDescribed.sections.find((section) => section.name === key)
    return row === undefined ? null : { officialHash: row.officialHash, officialText: row.officialText }
  }
})
assert.equal(copied.created, 0)
assert.equal(store.hasDraft(copySid), false)
assert.equal(store.library().fragments.find((fragment) => fragment.id === globalTemplate.id).text, 'globally edited in draft')

// A template saved before any baseline is global, awaiting, never
// unconditionally live, and is pinned by the first attach.
const pendingSid = 'session-draft-2'
const pendingAgent = createAgent(pendingSid, sections())
live.set(pendingSid, pendingAgent)
draftIds.add(pendingSid)
const pendingSaved = await api.handle({
  op: 'fragment.save',
  sessionId: pendingSid,
  key: 'harness:identity',
  mode: 'replace',
  text: 'pending identity'
})
assert.equal(pendingSaved.save.kind, 'created')
const pendingGlobal = store.library().fragments.find((fragment) => fragment.id === pendingSaved.save.fragmentId)
assert.equal(pendingGlobal.awaitingBaseline, true)
assert.equal(pendingGlobal.baseHash, null)
assert.equal(store.draft(pendingSid).fragments.length, 0)
assert.equal(store.draft(pendingSid).state.overrides['harness:identity'], pendingGlobal.id)
const pendingBefore = await api.handle({ op: 'state.get', sessionId: pendingSid })
assert.equal(pendingBefore.prompt.captured, false)
assert.equal((await pendingAgent.ctx.systemPrompt.assemble({ agent: pendingAgent, scope: pendingAgent })).sections[0].text, 'official identity')
await api.handle({ op: 'session.set', sessionId: pendingSid, enabled: true })
const attachPending = await engine.attach(pendingAgent)
assert.equal(attachPending.ok, true)
assert.notEqual(pendingGlobal.baseHash, null)
assert.equal(pendingGlobal.awaitingBaseline, undefined)
assert.equal((await pendingAgent.ctx.systemPrompt.assemble({ agent: pendingAgent, scope: pendingAgent })).sections[0].text, 'pending identity')
const pendingRow = (await api.handle({ op: 'state.get', sessionId: pendingSid })).prompt.sections.find((row) => row.name === 'harness:identity')
assert.equal(pendingRow.status, 'active')

// Applying a saved preset in a draft writes only draft state.
const presetConfig = await api.handle({ op: 'preset.capture', sessionId: draftSid, name: 'global-preset' })
const globalPreset = presetConfig.presets.find((preset) => preset.name === 'global-preset')
assert.ok(globalPreset !== undefined)
const applied = await api.handle({ op: 'preset.apply', sessionId: pendingSid, id: globalPreset.id })
assert.equal(applied.session.lastPreset.id, globalPreset.id)
assert.equal(applied.session.draft, true)
assert.equal(store.hasDraft(pendingSid), true)
assert.equal(fs.existsSync(path.join(dir, 'sessions', pendingSid, 'state.json')), false)

// Saving a preset from a blank window with no prior draft still writes the
// preset globally and keeps lastPreset in a freshly created draft.
const presetOnlySid = 'session-draft-preset-only'
const presetOnlyAgent = createAgent(presetOnlySid, sections())
live.set(presetOnlySid, presetOnlyAgent)
draftIds.add(presetOnlySid)
const presetOnly = await api.handle({ op: 'preset.capture', sessionId: presetOnlySid, name: 'preset-only' })
const presetOnlyEntry = presetOnly.presets.find((preset) => preset.name === 'preset-only')
assert.ok(presetOnlyEntry !== undefined)
assert.equal(presetOnly.session.lastPreset.id, presetOnlyEntry.id)
assert.equal(presetOnly.session.draft, true)
assert.equal(store.hasDraft(presetOnlySid), true)
assert.equal(fs.existsSync(path.join(dir, 'sessions', presetOnlySid, 'state.json')), false)

// GC: missing and expired drafts go; archived, live and unknown stay.
store.saveDraft('gc-missing', { state: { enabled: true }, fragments: [] })
store.saveDraft('gc-live', { state: { enabled: true }, fragments: [] })
store.saveDraft('gc-archived', { state: { enabled: true }, fragments: [] })
store.saveDraft('gc-unknown', { state: { enabled: true }, fragments: [] })
const expired = store.saveDraft('gc-expired', { state: { enabled: true }, fragments: [] })
expired.lastSeenAt = Date.now() - 48 * 60 * 60 * 1000
store.saveDraft('gc-expired', expired)
for (const id of ['gc-missing', 'gc-live', 'gc-archived', 'gc-unknown', 'gc-expired']) {
  const draft = store.draft(id)
  draft.lastSeenAt = Date.now() - 60 * 60 * 1000
  store.saveDraft(id, draft)
}
const expiredAgain = store.draft('gc-expired')
expiredAgain.lastSeenAt = Date.now() - 48 * 60 * 60 * 1000
fs.writeFileSync(path.join(dir, 'drafts', 'gc-expired.json'), JSON.stringify(expiredAgain))
store.cache.drafts.delete('gc-expired')
const gc = await store.gcDrafts(async () => new Map([
  ['gc-missing', { status: 'missing' }],
  ['gc-live', { status: 'live' }],
  ['gc-archived', { status: 'archived' }],
  ['gc-unknown', { status: 'unknown' }],
  ['gc-expired', { status: 'missing' }]
]))
assert.ok(gc.removed.includes('gc-missing'))
assert.ok(gc.removed.includes('gc-expired'))
assert.ok(gc.kept.includes('gc-live'))
assert.ok(gc.kept.includes('gc-archived'))
assert.ok(gc.kept.includes('gc-unknown'))

console.log('draft checks passed')
console.log('warnings:', warnings.slice(0, 4))
