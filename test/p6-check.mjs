/**
 * P6 text-library checks.
 *
 * Covers the sections.json v2 -> v3 migration, the inline-text link pass,
 * section text insert/reference/delete semantics, message text references used
 * by prefill, and draft behavior. Runs the Store/API directly; no Cordis.
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

// ---------------------------------------------------------------- v2 -> v3
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-p6-legacy-'))
fs.mkdirSync(path.join(legacyDir, 'library'), { recursive: true })
fs.writeFileSync(path.join(legacyDir, 'library', 'sections.json'), JSON.stringify({
  version: 2,
  fragments: [
    { id: 'frag_old', key: 'tool:bash', label: '旧模板', mode: 'replace', text: 'old', updatedAt: 10 }
  ]
}), 'utf8')
const legacyStore = new Store(legacyDir, [], () => ({ presetLimit: 10, autoBackupLimit: 20, manualBackupLimit: 5 }))
legacyStore.ensure()
const migrated = legacyStore.library()
assert.equal(migrated.version, 3)
assert.equal(migrated.fragments[0].target, 'override')
assert.equal(migrated.fragments[0].activation, 'persistent')

// ------------------------------------------------------------- main fixture
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-p6-'))
const warnings = []
const settings = { presetLimit: 10, autoBackupLimit: 20, manualBackupLimit: 5 }
const store = new Store(dir, warnings, () => settings, { isReadOnlySection: () => false })
store.ensure()
const live = new Map()
const draftIds = new Set()
const savedIds = new Set()
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
    {
      id,
      status: live.has(id) ? 'live' : savedIds.has(id) ? 'saved' : 'missing',
      title: null
    }
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

const sid = 'session-p6-main'
const agent = createAgent(sid, officialSections())
live.set(sid, agent)
await engine.attach(agent)

// ------------------------------------------------------- inline link pass
store.saveState(sid, {
  ...emptySession(),
  enabled: true,
  extras: [
    { id: 'extra_legacy', name: 'custom:legacy', anchor: '__end__', order: 10, text: 'legacy extra' }
  ],
  transientSections: [
    {
      id: 'transient_legacy',
      name: 'custom:legacy-once',
      anchor: '__end__',
      order: 20,
      text: 'legacy once',
      activation: 'once',
      enabled: true,
      consumedAtTurn: null,
      updatedAt: 1
    }
  ],
  autoAssistant: { enabled: true, text: 'legacy prefill' }
})
const migration = store.migrateInlineSections()
assert.equal(migration.sessions, 1)
const afterMigration = store.state(sid)
const legacyEntry = store.library().fragments.find((fragment) => fragment.key === 'custom:legacy')
assert.ok(legacyEntry)
assert.equal(legacyEntry.target, 'insert')
assert.equal(afterMigration.extras[0].textId, legacyEntry.id)
const onceEntry = store.library().fragments.find((fragment) => fragment.key === 'custom:legacy-once')
assert.equal(onceEntry.activation, 'once')
assert.equal(afterMigration.transientSections[0].textId, onceEntry.id)
const legacyMessage = store.messageLibrary().entries.find((entry) => entry.text === 'legacy prefill')
assert.ok(legacyMessage)
assert.equal(afterMigration.autoAssistant.textId, legacyMessage.id)

let described = engine.describe(sid)
assert.equal(described.sections.find((row) => row.name === 'custom:legacy').text, 'legacy extra')
assert.equal(described.sections.find((row) => row.name === 'custom:legacy-once'), undefined)

// ------------------------------------------------ extra -> shared text entry
const savedExtra = await api.handle({
  op: 'extra.save',
  sessionId: sid,
  name: 'custom:persist',
  anchor: 'tool:bash',
  text: 'persist text'
})
const persistEntry = savedExtra.library.fragments.find((fragment) =>
  fragment.key === 'custom:persist' && fragment.target === 'insert')
assert.ok(persistEntry)
let state = store.state(sid)
assert.equal(state.extras.find((extra) => extra.name === 'custom:persist').textId, persistEntry.id)

const editedExtra = await api.handle({
  op: 'extra.save',
  sessionId: sid,
  name: 'custom:persist',
  anchor: 'tool:bash',
  text: 'persist text v2'
})
const persistEntries = editedExtra.library.fragments.filter((fragment) =>
  fragment.key === 'custom:persist' && fragment.target === 'insert')
assert.equal(persistEntries.length, 1)
assert.equal(persistEntries[0].id, persistEntry.id)
assert.equal(persistEntries[0].text, 'persist text v2')
assert.equal(engine.describe(sid).sections.find((row) => row.name === 'custom:persist').text, 'persist text v2')

// Deleting the session section only removes the reference.
await api.handle({ op: 'extra.delete', sessionId: sid, id: state.extras.find((extra) => extra.name === 'custom:persist').id })
assert.ok(store.library().fragments.some((fragment) => fragment.id === persistEntry.id))
assert.ok(!store.state(sid).extras.some((extra) => extra.name === 'custom:persist'))

// --------------------------------------------- section text create / insert
const created = await api.handle({
  op: 'sectionText.create',
  sessionId: sid,
  key: 'custom:reusable',
  label: '可复用段',
  activation: 'once',
  text: 'reusable text'
})
const reusable = created.text.entry
assert.equal(reusable.activation, 'persistent')
const fetchedReusable = await api.handle({ op: 'sectionText.get', id: reusable.id })
assert.equal(fetchedReusable.text, 'reusable text')
await api.handle({ op: 'sectionText.update', sessionId: sid, id: reusable.id, text: 'reusable text v2' })
assert.equal(engine.describe(sid).sections.find((row) => row.name === 'custom:reusable')?.text, undefined)
const inserted = await api.handle({
  op: 'sectionText.insert',
  sessionId: sid,
  id: reusable.id,
  anchor: '__end__'
})
assert.equal(inserted.insert.kind, 'extra')
state = store.state(sid)
const insertedTransient = state.extras.find((entry) => entry.name === 'custom:reusable')
assert.equal(insertedTransient.textId, reusable.id)

described = engine.describe(sid)
assert.equal(described.sections.find((row) => row.name === 'custom:reusable').text, 'reusable text v2')
assert.equal(described.sections.find((row) => row.name === 'custom:reusable').textId, reusable.id)

const listed = await api.handle({ op: 'library.list', sessionId: sid })
const listedEntry = listed.fragments.find((fragment) => fragment.id === reusable.id)
assert.equal(listedEntry.target, 'insert')
assert.equal(listedEntry.activation, 'persistent')
assert.equal(listedEntry.usage.sessions.some((entry) => entry.id === sid), true)

// Removing the session reference keeps the library entry.
await api.handle({ op: 'extra.delete', sessionId: sid, id: insertedTransient.id })
assert.ok(store.library().fragments.some((fragment) => fragment.id === reusable.id))

// Re-insert and delete through the library with cascade; the session section
// and the entry both disappear, and the deletion lists the dependency.
const reinserted = await api.handle({ op: 'sectionText.insert', sessionId: sid, id: reusable.id })
assert.equal(reinserted.insert.kind, 'extra')
const insertedAgain = store.state(sid).extras.find((entry) => entry.name === 'custom:reusable')
// The current session alone is allowed without cascade (same rule as an
// official override); other sessions/drafts require it.
const deleted = await api.handle({ op: 'fragment.delete', sessionId: sid, id: reusable.id, cascade: true })
assert.equal(deleted.deleted.sessions.some((entry) => entry.id === sid), true)
assert.ok(!store.library().fragments.some((fragment) => fragment.id === reusable.id))
assert.ok(!store.state(sid).extras.some((entry) => entry.id === insertedAgain.id))

// ------------------------------------------------------------- message text
const savedMessage = await api.handle({
  op: 'messages.text.save',
  sessionId: sid,
  label: '固定回复',
  text: 'fixed reply'
})
const messageId = savedMessage.text.id
assert.ok(messageId)
let messages = await api.handle({ op: 'messages.text.list', sessionId: sid })
assert.equal(messages.entries.some((entry) => entry.id === messageId), true)

await api.handle({ op: 'messages.text.save', sessionId: sid, id: messageId, label: '固定回复', text: 'fixed reply v2' })
messages = await api.handle({ op: 'messages.text.list', sessionId: sid })
assert.equal(messages.entries.find((entry) => entry.id === messageId).text, 'fixed reply v2')

const deletedMessage = await api.handle({ op: 'messages.text.delete', sessionId: sid, id: messageId })
assert.equal(deletedMessage.deleted.id, messageId)
messages = await api.handle({ op: 'messages.text.list', sessionId: sid })
assert.equal(messages.entries.some((entry) => entry.id === messageId), false)
// Removing a message-text entry never rewrites already-sent history; the
// library entry is simply gone.
assert.notEqual(store.state(sid).autoAssistant.textId, messageId)

// --------------------------------------------------------- draft reference
const draftSid = 'session-p6-draft'
draftIds.add(draftSid)
const draftCreated = await api.handle({
  op: 'sectionText.create',
  sessionId: draftSid,
  key: 'custom:draft-text',
  text: 'draft text',
  activation: 'once'
})
const draftEntry = draftCreated.text.entry
await api.handle({ op: 'sectionText.insert', sessionId: draftSid, id: draftEntry.id })
assert.equal(store.hasDraft(draftSid), true)
assert.equal(fs.existsSync(path.join(dir, 'sessions', draftSid, 'state.json')), false)
assert.equal(store.draft(draftSid).state.extras[0].textId, draftEntry.id)
const draftList = await api.handle({ op: 'library.list', sessionId: draftSid })
const draftUsage = draftList.fragments.find((fragment) => fragment.id === draftEntry.id).usage
assert.equal(draftUsage.drafts.some((entry) => entry.id === draftSid), true)

// Other draft references block a library delete unless cascade is explicit.
await assert.rejects(
  () => api.handle({ op: 'fragment.delete', sessionId: sid, id: draftEntry.id }),
  /仍被引用/
)
const draftDeleted = await api.handle({ op: 'fragment.delete', sessionId: sid, id: draftEntry.id, cascade: true })
assert.equal(draftDeleted.deleted.sessions.some((entry) => entry.draft === true), true)
assert.equal(store.draft(draftSid).state.extras.length, 0)

// --------------------------------------------------------------- limits
// The legacy prefill migration created one reusable message entry.
assert.equal((await api.handle({ op: 'library.list', sessionId: sid })).messageEntries, 1)

console.log('P6 checks passed')
console.log('warnings:', warnings)
