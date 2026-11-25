/**
 * Locked-prompt drift checks.
 *
 * A locked session renders overrides from `locked.json`. When DSH changes the
 * official text of an overridden section, that override keeps the model on
 * stale wording; drift detection must yield it so the new official text takes
 * over. Pure official sections are owned by DSH and are only marked.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, Store, sha16 } from '../lib/store.js'
import { createEngine } from '../lib/engine.js'

const ORDER_KEYS = {
  HARNESS_IDENTITY: -1000,
  TOOL_BASH: 1000,
  TOOL_READ: 1100
}

function makePrompt (sections) {
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
      return {
        sections: definitions.map((definition) => ({
          name: definition.name,
          text: typeof definition.text === 'function' ? definition.text(context) : String(definition.text ?? ''),
          ...(definition.interpolate === false ? { interpolate: false } : {})
        })),
        contexts: [],
        tools: [],
        variables: {}
      }
    }
  }
  sp.layers = {
    merge () {
      const merged = new Map(sections.map((section) => [section.name, section]))
      for (const [name, definition] of scoped) merged.set(name, definition)
      return merged
    }
  }
  return sp
}

function createAgent (id, prompt) {
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
  return { id, ctx }
}

function createHarness (sections) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-drift-'))
  const warnings = []
  const logs = []
  const settings = { ...DEFAULT_CONFIG }
  const store = new Store(dir, warnings, () => settings, { isReadOnlySection: () => false })
  store.ensure()
  const engine = createEngine({
    store,
    logger: { warn: (message) => logs.push(message) },
    releaseOf: () => '0.2.2-rc.3',
    readOnlySection: () => false,
    presetOf: () => ({ id: 'default', name: 'Default' })
  })
  const prompt = makePrompt(sections)
  const agent = createAgent('drift-session', prompt)
  return { dir, store, engine, prompt, agent, sections, logs }
}

async function textOf (prompt, name) {
  const assembly = await prompt.assemble({})
  const row = assembly.sections.find((section) => section.name === name)
  return row === undefined ? null : row.text
}

/** Snapshot the current assembly the way index.js lockSession does. */
function lockFrom (store, sessionId, described) {
  const rows = described.sections
  const sections = rows.map((row) => {
    const official = row.status === 'official' || row.status === 'blocked'
    const text = official || typeof row.text !== 'string' ? null : row.text
    return {
      name: row.name,
      status: row.status,
      mode: 'replace',
      text,
      textId: null,
      fragmentId: row.fragmentId ?? null,
      extraId: row.extraId ?? null,
      anchor: row.anchor ?? null,
      order: row.order ?? null,
      source: row.source ?? null,
      readOnly: row.readOnly === true,
      officialHash: row.officialHash ?? null,
      textHash: text === null ? null : sha16(text),
      yielded: false,
      drift: null
    }
  })
  store.saveLockedSnapshot(sessionId, {
    lockedAt: 1,
    firstTurn: 1,
    source: 'first-turn',
    renderedHash: sha16(rows.map((row) => `${row.name}\n${row.text ?? ''}`).join('\n')),
    sectionSetHash: sha16(rows.map((row) => row.name).join('\n')),
    sections
  })
}

function setOverride (harness, sessionId, key, text) {
  const { store, engine } = harness
  const fragmentId = `frag_${key.replace(/[^a-z0-9]+/gi, '_')}`
  const library = store.library()
  const existing = library.fragments.find((fragment) => fragment.id === fragmentId)
  if (existing !== undefined) existing.text = text
  else library.fragments.push({
    id: fragmentId,
    key,
    label: 'override',
    mode: 'replace',
    target: 'override',
    text,
    baseHash: null,
    baseText: '',
    createdAt: 1,
    updatedAt: 1
  })
  store.saveLibrary(library)
  const state = store.stateFor(sessionId)
  store.saveState(sessionId, {
    ...state,
    enabled: true,
    overrides: { ...(state.overrides ?? {}), [key]: fragmentId }
  })
  engine.sync(sessionId)
}

function sectionsV1 () {
  return [
    { name: 'harness:identity', order: -1000, text: 'official v1' },
    { name: 'tool:bash', order: 1000, text: 'bash' },
    { name: 'tool:read', order: 1100, text: 'read' }
  ]
}

// 1. An unchanged official text keeps the override, and a changed one yields it.
{
  const harness = createHarness(sectionsV1())
  await harness.engine.attach(harness.agent)
  setOverride(harness, 'drift-session', 'harness:identity', 'MY OVERRIDE')
  await harness.engine.attach(harness.agent, { force: true })
  assert.equal(await textOf(harness.prompt, 'harness:identity'), 'MY OVERRIDE')

  lockFrom(harness.store, 'drift-session', harness.engine.describe('drift-session'))
  const locked = harness.store.lockedSnapshot('drift-session')
  assert.equal(locked.version, 2)
  assert.equal(locked.migratedFrom, undefined)
  const identity = locked.sections.find((section) => section.name === 'harness:identity')
  assert.equal(identity.status, 'active')
  assert.equal(identity.text, 'MY OVERRIDE')
  assert.equal(typeof identity.officialHash, 'string')

  // Same official text: re-attaching changes nothing.
  await harness.engine.attach(harness.agent, { force: true })
  assert.equal(await textOf(harness.prompt, 'harness:identity'), 'MY OVERRIDE')
  assert.equal(harness.engine.describe('drift-session').sections
    .find((row) => row.name === 'harness:identity').yielded, false)

  // DSH ships new official wording: the override must yield.
  harness.sections[0].text = 'official v2'
  await harness.engine.attach(harness.agent, { force: true })
  const row = harness.engine.describe('drift-session').sections
    .find((entry) => entry.name === 'harness:identity')
  assert.equal(row.drift, 'changed')
  assert.equal(row.yielded, true)
  assert.equal(await textOf(harness.prompt, 'harness:identity'), 'official v2')
  const after = harness.store.lockedSnapshot('drift-session').sections
    .find((section) => section.name === 'harness:identity')
  assert.equal(after.yielded, true)
  // The yielded override text is kept for display.
  assert.equal(after.text, 'MY OVERRIDE')
}

// 2. A yielded snapshot survives a restart (fresh Store reads the same file).
{
  const harness = createHarness(sectionsV1())
  await harness.engine.attach(harness.agent)
  setOverride(harness, 'drift-session', 'harness:identity', 'MY OVERRIDE')
  await harness.engine.attach(harness.agent, { force: true })
  lockFrom(harness.store, 'drift-session', harness.engine.describe('drift-session'))
  harness.sections[0].text = 'official v2'
  await harness.engine.attach(harness.agent, { force: true })

  const settings = { ...DEFAULT_CONFIG }
  const restarted = new Store(harness.dir, [], () => settings, { isReadOnlySection: () => false })
  const engine = createEngine({
    store: restarted,
    logger: { warn: () => {} },
    releaseOf: () => '0.2.2-rc.3',
    readOnlySection: () => false,
    presetOf: () => ({ id: 'default', name: 'Default' })
  })
  const prompt = makePrompt(harness.sections)
  const agent = createAgent('drift-session', prompt)
  await engine.attach(agent)
  assert.equal(await textOf(prompt, 'harness:identity'), 'official v2')
  assert.equal(engine.describe('drift-session').sections
    .find((row) => row.name === 'harness:identity').yielded, true)
}

// 3. v1 snapshots migrate on read; the first pass backfills official sections
//    without reporting them as newly added.
{
  const harness = createHarness(sectionsV1())
  await harness.engine.attach(harness.agent)
  const dir = harness.store.sessionDir('drift-session')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'locked.json'), JSON.stringify({
    version: 1,
    sessionId: 'drift-session',
    lockedAt: 1,
    firstTurn: 1,
    source: 'first-turn',
    sections: [{
      name: 'harness:identity',
      status: 'active',
      mode: 'replace',
      text: 'MY OVERRIDE',
      fragmentId: 'frag_harness_identity',
      order: -1000,
      source: 'official',
      readOnly: false
    }]
  }))
  harness.store.cache.locked.clear()
  const migrated = harness.store.lockedSnapshot('drift-session')
  assert.equal(migrated.version, 2)
  assert.equal(migrated.migratedFrom, 1)
  assert.equal(migrated.sections[0].officialHash, null)

  await harness.engine.attach(harness.agent, { force: true })
  const backfilled = harness.store.lockedSnapshot('drift-session')
  assert.equal(backfilled.migratedFrom, undefined)
  assert.ok(backfilled.sections.some((section) => section.name === 'tool:read'))
  assert.equal(backfilled.sections.find((section) => section.name === 'harness:identity').officialHash !== null, true)
  const described = harness.engine.describe('drift-session')
  assert.equal(described.sections.find((row) => row.name === 'harness:identity').drift, null)
}

// 4. Official sections that appear or disappear are marked, never yielded.
{
  const harness = createHarness(sectionsV1())
  await harness.engine.attach(harness.agent)
  lockFrom(harness.store, 'drift-session', harness.engine.describe('drift-session'))
  harness.sections.push({ name: 'custom:not-official', order: 5000, text: 'new' })
  await harness.engine.attach(harness.agent, { force: true })
  const pluginRow = harness.engine.describe('drift-session').sections
    .find((row) => row.name === 'custom:not-official')
  // A plugin/unknown section is not in the official assembly baseline, so it
  // never shows up as an official addition.
  assert.equal(pluginRow.drift, null)
  assert.equal(harness.store.lockedSnapshot('drift-session').sections
    .some((section) => section.name === 'custom:not-official'), false)

  harness.sections.splice(harness.sections.findIndex((section) => section.name === 'tool:read'), 1)
  await harness.engine.attach(harness.agent, { force: true })
  const removed = harness.engine.describe('drift-session').sections
    .find((row) => row.name === 'tool:read')
  assert.equal(removed, undefined)
  const snapshot = harness.store.lockedSnapshot('drift-session').sections
    .find((section) => section.name === 'tool:read')
  assert.equal(snapshot.drift, 'removed')
}

console.log('drift checks passed')
