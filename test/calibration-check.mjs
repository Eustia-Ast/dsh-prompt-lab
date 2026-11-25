/**
 * Order calibration checks: a section whose order was never observed must stay
 * unverified, must not register an override, and must not enter the cache.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, Store } from '../lib/store.js'
import { createEngine } from '../lib/engine.js'

const ORDER_KEYS = {
  HARNESS_IDENTITY: -1000,
  PLAN_POLICY: 500,
  TOOL_BASH: 1000,
  TOOL_READ: 1100
}

function makePrompt (sections, options = {}) {
  const scoped = new Map()
  let assembleCount = 0
  const sp = {
    section (definition) {
      if (scoped.has(definition.name)) throw new Error(`duplicate section ${definition.name}`)
      if (typeof options.failProbeRegister === 'function' &&
          String(definition.name).startsWith('prompt-lab:probe:') &&
          options.failProbeRegister(definition)) {
        throw new Error('probe register failed')
      }
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
      assembleCount += 1
      if (options.failAssembleAt === assembleCount) throw new Error('assemble failed')
      const merged = new Map(sections.map((section) => [section.name, section]))
      for (const [name, definition] of scoped) merged.set(name, definition)
      let definitions = [...merged.values()].sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      })
      if (options.hideProbes === true) {
        definitions = definitions.filter((definition) => !String(definition.name).startsWith('prompt-lab:probe:'))
      }
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
    },
    assembleCount: () => assembleCount
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

function createHarness (sections, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-cal-'))
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
  const prompt = makePrompt(sections, options)
  const agent = createAgent(options.sessionId ?? 'cal-session', prompt)
  return { store, engine, prompt, agent, logs }
}

function setOverride (harness, sessionId, key, text) {
  const { store, engine } = harness
  const fragmentId = `frag_${key.replace(/[^a-z0-9]+/gi, '_')}`
  const library = store.library()
  const existing = library.fragments.find((fragment) => fragment.id === fragmentId)
  if (existing !== undefined) {
    existing.text = text
    existing.updatedAt = 2
  } else {
    library.fragments.push({
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
  }
  store.saveLibrary(library)
  const state = store.stateFor(sessionId)
  store.saveState(sessionId, {
    ...state,
    enabled: true,
    overrides: { ...(state.overrides ?? {}), [key]: fragmentId }
  })
  engine.sync(sessionId)
}

async function assembledText (prompt, name) {
  const assembly = await prompt.assemble({})
  const row = assembly.sections.find((section) => section.name === name)
  return row === undefined ? null : row.text
}

function baseSections () {
  return [
    { name: 'harness:identity', order: -1000, text: 'identity' },
    { name: 'hidden:unknown', order: 2711.5, text: 'unknown text' },
    { name: 'tool:bash', order: 1000, text: 'bash' }
  ]
}

// 1 + 2. A verifiable order is calibrated once, applied, and then cached.
{
  const harness = createHarness(baseSections(), { hideLayers: true, sessionId: 'cal-happy-1' })
  const attached = await harness.engine.attach(harness.agent)
  assert.equal(attached.ok, true)
  assert.ok(harness.logs.some((line) => /calibrated prompt order for 1 section/.test(line)), 'happy path reports success')
  setOverride(harness, 'cal-happy-1', 'hidden:unknown', 'CALIBRATED OVERRIDE')
  const names = (await harness.prompt.assemble({})).sections.map((section) => section.name)
  assert.deepEqual(names, ['harness:identity', 'tool:bash', 'hidden:unknown'])
  assert.equal(await assembledText(harness.prompt, 'hidden:unknown'), 'CALIBRATED OVERRIDE')

  // Same section names on another agent: cache hit, two baseline assembles only.
  const secondPrompt = makePrompt(baseSections(), { hideLayers: true })
  const secondAgent = createAgent('cal-happy-2', secondPrompt)
  const before = secondPrompt.assembleCount()
  await harness.engine.attach(secondAgent)
  assert.equal(secondPrompt.assembleCount() - before, 2)
}

// 3 + 4. A failed assembly is reported (never as success) and is not cached, so
// a later healthy agent calibrates from scratch instead of reusing a guess.
{
  const harness = createHarness(baseSections(), { hideLayers: true, failAssembleAt: 3, sessionId: 'cal-fail-1' })
  const attached = await harness.engine.attach(harness.agent)
  assert.equal(attached.ok, true)
  assert.ok(harness.logs.some((line) => /order calibration aborted \(assembly-failed\)/.test(line)))
  assert.ok(!harness.logs.some((line) => /calibrated prompt order/.test(line)))
  setOverride(harness, 'cal-fail-1', 'hidden:unknown', 'SHOULD NOT APPLY')
  assert.equal(await assembledText(harness.prompt, 'hidden:unknown'), 'unknown text')

  const healthyPrompt = makePrompt(baseSections(), { hideLayers: true })
  const healthyAgent = createAgent('cal-fail-2', healthyPrompt)
  await harness.engine.attach(healthyAgent)
  assert.ok(harness.logs.some((line) => /calibrated prompt order for 1 section/.test(line)))
  setOverride(harness, 'cal-fail-2', 'hidden:unknown', 'RECALIBRATED')
  assert.equal(await assembledText(healthyPrompt, 'hidden:unknown'), 'RECALIBRATED')
}

// 5. Probes that never appear in the assembly stay unverified (timeout path).
{
  const harness = createHarness(baseSections(), { hideLayers: true, hideProbes: true, sessionId: 'cal-missing-1' })
  await harness.engine.attach(harness.agent)
  assert.ok(harness.logs.some((line) => /did not converge/.test(line)))
  assert.ok(!harness.logs.some((line) => /calibrated prompt order/.test(line)))
  setOverride(harness, 'cal-missing-1', 'hidden:unknown', 'SHOULD NOT APPLY')
  assert.equal(await assembledText(harness.prompt, 'hidden:unknown'), 'unknown text')
}

// 6. Adjacent equal orders: the first section verifies, the second cannot be
// separated, and its override keeps the official text.
{
  const harness = createHarness([
    { name: 'harness:identity', order: -1000, text: 'identity' },
    { name: 'hidden:a', order: 500, text: 'a' },
    { name: 'hidden:b', order: 500, text: 'b' },
    { name: 'tool:bash', order: 1000, text: 'bash' }
  ], { hideLayers: true, sessionId: 'cal-tie-1' })
  await harness.engine.attach(harness.agent)
  assert.ok(harness.logs.some((line) => /left without a verified order/.test(line)))
  setOverride(harness, 'cal-tie-1', 'hidden:a', 'A OVERRIDE')
  setOverride(harness, 'cal-tie-1', 'hidden:b', 'B OVERRIDE')
  assert.equal(await assembledText(harness.prompt, 'hidden:a'), 'A OVERRIDE')
  assert.equal(await assembledText(harness.prompt, 'hidden:b'), 'b')
}

// 7. A readable registry skips calibration entirely.
{
  const harness = createHarness([
    { name: 'harness:identity', order: -1000, text: 'identity' },
    { name: 'tool:bash', order: 1000, text: 'bash' }
  ], { sessionId: 'cal-registry-1' })
  await harness.engine.attach(harness.agent)
  assert.equal(harness.prompt.assembleCount(), 2)
  assert.ok(!harness.logs.some((line) => /calibrat/i.test(line)))
}

console.log('calibration checks passed')
