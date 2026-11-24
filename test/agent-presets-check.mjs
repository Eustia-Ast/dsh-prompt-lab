/**
 * Agent preset controller checks (storage, registration, validation).
 *
 * Preset copying is not covered here: it parses the registry's YAML with
 * `js-yaml`, which this package declares as a dependency but does not vendor, so
 * the copy path is exercised separately against an installed Host.
 */
import assert from 'node:assert/strict'
import * as mod from '../lib/agent-presets.js'

const failures = []
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL ${name}: ${error.message}`)
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

function fakeStore () {
  return {
    doc: { version: 1, presets: [] },
    readAgentPresets (fallback) { return JSON.parse(JSON.stringify(this.doc ?? fallback)) },
    writeAgentPresets (value) { this.doc = JSON.parse(JSON.stringify(value)) },
    library () {
      return {
        fragments: [
          { id: 'frag-a', label: '人格', text: 'FRAGMENT-TEXT', mode: 'replace', target: 'override' },
          { id: 'frag-empty', label: '空', text: '   ', mode: 'replace', target: 'override' }
        ]
      }
    }
  }
}

function fakeService () {
  const live = new Map()
  const disposed = []
  return {
    live,
    disposed,
    async register (definition) {
      if (live.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
      live.set(definition.id, definition)
      return async () => {
        disposed.push(definition.id)
        live.delete(definition.id)
      }
    },
    async list () {
      return [...live.keys()].map((id) => ({ id }))
    }
  }
}

check('buildDefinition materializes persona and catalog rows', () => {
  const definition = mod.buildDefinition({
    id: 'review',
    name: 'Review',
    description: 'd',
    order: 7,
    rows: ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-todo', '@bogus/pkg'],
    prompt: { prefix: 'P', suffix: '' }
  })
  assert.equal(definition.id, 'review')
  assert.equal(definition.order, 7)
  assert.deepEqual(definition.plugins.map((row) => row.name), [
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-todo'
  ])
  assert.deepEqual(definition.plugins[2].config, { allowParallelInProgress: true })
})

await checkAsync('attach registers enabled presets only', async () => {
  const store = fakeStore()
  store.doc = {
    version: 1,
    presets: [
      { id: 'on', name: 'On', order: 1, enabled: true, rows: [], prompt: { fragmentIds: [], text: '', prefix: '', suffix: '' } },
      { id: 'off', name: 'Off', order: 2, enabled: false, rows: [], prompt: { fragmentIds: [], text: '', prefix: '', suffix: '' } }
    ]
  }
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  const count = await controller.attach(service)
  assert.equal(count, 1)
  assert.ok(service.live.has('on'))
  const state = await controller.state()
  assert.equal(state.supported, true)
  assert.equal(state.presets.find((preset) => preset.id === 'on').runtime.mounted, true)
  await controller.disposeAll()
  assert.equal(service.live.size, 0)
})

await checkAsync('save persists, registers and materializes the fragment text', async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  const next = await controller.save({
    id: 'Review',
    name: 'Review',
    description: 'code review',
    order: 5,
    rows: ['@deepseek-ai/dsh-tool-fs'],
    prompt: { fragmentIds: ['frag-a', 'frag-empty'], text: 'TAIL' }
  })
  assert.equal(next.saved.registered, true)
  const stored = store.doc.presets[0]
  assert.equal(stored.id, 'review')
  assert.equal(stored.prompt.prefix, 'FRAGMENT-TEXT\n\nTAIL')
  assert.equal(service.live.get('review').plugins[0].config.prefix, 'FRAGMENT-TEXT\n\nTAIL')
  await controller.disposeAll()
})

await checkAsync('save refuses reserved and invalid ids', async () => {
  const store = fakeStore()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(fakeService())
  await assert.rejects(() => controller.save({ id: 'standard', rows: [], prompt: {} }), /内置预设 id/)
  await assert.rejects(() => controller.save({ id: 'Bad Id', rows: [], prompt: {} }), /小写字母/)
  await assert.rejects(() => controller.save({ id: 'x', rows: [], prompt: {} }), /小写字母/)
})

await checkAsync('save refuses an id that another plugin already registered', async () => {
  const store = fakeStore()
  const service = fakeService()
  await service.register({ id: 'foreign', name: 'Foreign', plugins: [] })
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  await assert.rejects(() => controller.save({ id: 'foreign', rows: [], prompt: {} }), /已经有 id/)
})

await checkAsync('re-saving replaces the previous registration', async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  await controller.save({ id: 'review', name: 'One', rows: [], prompt: { text: 'A' } })
  await controller.save({ id: 'review', name: 'Two', rows: [], prompt: { text: 'B' } })
  assert.deepEqual(service.disposed, ['review'])
  assert.equal(service.live.get('review').name, 'Two')
  assert.equal(service.live.get('review').plugins[0].config.prefix, 'B')
  await controller.disposeAll()
})

await checkAsync('disable unregisters but keeps the definition', async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  await controller.save({ id: 'review', rows: [], prompt: {} })
  const next = await controller.save({ id: 'review', rows: [], prompt: {}, enabled: false })
  assert.equal(service.live.has('review'), false)
  assert.equal(next.presets[0].enabled, false)
  await controller.disposeAll()
})

await checkAsync('remove deletes the definition and unregisters', async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  await controller.save({ id: 'review', rows: [], prompt: {} })
  const next = await controller.remove('review')
  assert.equal(next.presets.length, 0)
  assert.equal(store.doc.presets.length, 0)
  assert.equal(service.live.has('review'), false)
  await assert.rejects(() => controller.remove('review'), /没有 id/)
})

await checkAsync('a broken definition still registers and surfaces broken', async () => {
  const store = fakeStore()
  const live = new Set()
  const service = {
    async register (definition) {
      live.add(definition.id)
      return async () => live.delete(definition.id)
    },
    async list () {
      return [...live].map((id) => ({ id, broken: 'tool-x: boom' }))
    }
  }
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  const next = await controller.save({ id: 'review', rows: [], prompt: {} })
  assert.equal(next.presets[0].runtime.mounted, false)
  assert.equal(next.presets[0].runtime.broken, 'tool-x: boom')
})

await checkAsync('without the service, save persists and reports the failure', async () => {
  const store = fakeStore()
  const controller = mod.createAgentPresets({ store })
  const state = await controller.state()
  assert.equal(state.supported, false)
  const next = await controller.save({ id: 'review', rows: [], prompt: {} })
  assert.equal(next.presets.length, 1)
  assert.equal(next.saved.registered, false)
  assert.match(next.saved.error, /agentPresets 服务不可用/)
})

await checkAsync('reset unregisters everything and clears failures', async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  await controller.save({ id: 'one', rows: [], prompt: {} })
  await controller.save({ id: 'two', rows: [], prompt: {} })
  store.doc = { version: 1, presets: [] }
  await controller.reset()
  assert.equal(service.live.size, 0)
  const state = await controller.state()
  assert.equal(state.presets.length, 0)
  assert.equal(state.failures.length, 0)
})

await checkAsync('raw plugins round-trip and strict config validation', async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  const saved = await controller.save({
    id: 'raw',
    name: 'Raw',
    rows: [],
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'x' }, disabled: { __jsExpr: 'false' } }
    ],
    prompt: { fragmentIds: ['frag-a'], text: 'IGNORED' }
  })
  assert.equal(saved.saved.registered, true)
  const stored = store.doc.presets[0]
  assert.equal(stored.plugins.length, 1)
  assert.equal(stored.plugins[0].disabled.__jsExpr, 'false')
  assert.equal(stored.prompt.prefix, '')
  await assert.rejects(
    () => controller.save({ id: 'raw-two', plugins: [{ name: 'x', config: 'oops' }] }),
    /第 1 行的 config/
  )
  const state = await controller.state()
  const todo = state.catalog.find((row) => row.name === '@deepseek-ai/dsh-tool-todo')
  assert.deepEqual(todo.config, { allowParallelInProgress: true })
  assert.match(state.schemaStatus.table, /^0\./)
  assert.match(state.schemaStatus.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(
    state.schemaStatus.stale,
    state.schemaStatus.current !== null && state.schemaStatus.current !== state.schemaStatus.table
  )
  assert.equal(state.templates.length, 4)
  assert.ok(state.templates.every((template) => template.rows.length > 0))
  assert.ok(Array.isArray(state.copyOnly) && state.copyOnly.length === 7)
  assert.equal(state.platform, process.platform)
  assert.equal(state.catalog.find((row) => row.name === '@deepseek-ai/dsh-tool-bash').platform, 'posix')
  assert.equal(state.catalog.find((row) => row.name === '@deepseek-ai/dsh-tool-pwsh').platform, 'win32')
})

await checkAsync("templates become group rows and keep their isolate", async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  const next = await controller.save({
    id: "with-template",
    name: "With template",
    rows: ["@deepseek-ai/dsh-tool-fs"],
    templates: ["compaction"],
    prompt: { fragmentIds: [], text: "" }
  })
  assert.equal(next.saved.registered, true)
  const stored = store.doc.presets[0]
  assert.deepEqual(stored.templates, ["compaction"])
  const definition = service.live.get("with-template")
  const group = definition.plugins.find((row) => row.group === true)
  assert.ok(group !== undefined)
  assert.equal(group.name, "cordis:group")
  assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true })
  await controller.disposeAll()
})

await checkAsync("persistent shell template conflicts with bash rows", async () => {
  const store = fakeStore()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(fakeService())
  await assert.rejects(
    () => controller.save({ id: "conflict", rows: ["@deepseek-ai/dsh-tool-bash"], templates: ["persistent-shell"], prompt: { fragmentIds: [], text: "" } }),
    /不能同时使用/
  )
})

await checkAsync("rowConfigs override catalog defaults and persist", async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  await controller.save({
    id: "with-config",
    name: "With config",
    rows: ["@deepseek-ai/dsh-tool-fs"],
    rowConfigs: { "@deepseek-ai/dsh-tool-fs": { write: false, readLimit: 100 } },
    prompt: { fragmentIds: [], text: "" }
  })
  const stored = store.doc.presets[0]
  assert.deepEqual(stored.rowConfigs, { "@deepseek-ai/dsh-tool-fs": { write: false, readLimit: 100 } })
  const row = service.live.get("with-config").plugins.find((entry) => entry.name === "@deepseek-ai/dsh-tool-fs")
  assert.equal(row.config.write, false)
  assert.equal(row.config.readLimit, 100)
  assert.equal(row.config.applyPatch, false)
  await controller.disposeAll()
})

await checkAsync("delegation template follows subagent provider availability", async () => {
  const build = (subagentProviders) => mod.createAgentPresets({ store: fakeStore(), subagentProviders })
  const unknown = build(() => null)
  const none = build(() => [])
  const forked = build((names) => names.filter((name) => name === 'fork'))
  const services = [fakeService(), fakeService(), fakeService()]
  await unknown.attach(services[0])
  await none.attach(services[1])
  await forked.attach(services[2])
  const ids = async (controller) => (await controller.state()).templates.map((template) => template.id).sort()
  const all = ['compaction', 'delegation', 'persistent-shell', 'planning']
  // "Cannot tell" keeps the template; a known-empty provider list hides it.
  assert.deepEqual(await ids(unknown), all)
  assert.deepEqual(await ids(none), ['compaction', 'persistent-shell', 'planning'])
  assert.deepEqual(await ids(forked), all)
  // No probe at all (tests, older wiring) keeps every template.
  const plain = mod.createAgentPresets({ store: fakeStore() })
  await plain.attach(fakeService())
  assert.deepEqual(await ids(plain), all)
  for (const controller of [unknown, none, forked, plain]) await controller.disposeAll()
})

await checkAsync("acceptance: catalog, fields and copy-only classification", async () => {
  const controller = mod.createAgentPresets({ store: fakeStore() })
  const service = fakeService()
  await controller.attach(service)
  const state = await controller.state()
  const names = state.catalog.map((row) => row.name)
  for (const name of [
    '@deepseek-ai/dsh-time-context',
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-command-goal',
    '@deepseek-ai/dsh-tool-schedule',
    '@deepseek-ai/dsh-tool-fs'
  ]) {
    assert.ok(names.includes(name), `catalog missing ${name}`)
  }
  // A-class rows expose fields; mount-only rows expose no fields but still add.
  assert.equal(state.catalog.length, 16)
  assert.ok(state.catalog.every((row) => Array.isArray(row.fields) && Array.isArray(row.tools) && Array.isArray(row.required)))
  const withFields = state.catalog.filter((row) => row.fields.length > 0)
  assert.ok(withFields.length >= 8)
  assert.ok(withFields.every((row) => row.required.every((key) => row.fields.some((field) => field.key === key))))
  assert.ok(state.catalog.some((row) => row.fields.length === 0))
  assert.ok(state.catalog.every((row) => row.fields.length === 0 || typeof row.config === 'object'))
  assert.equal(state.copyOnly.length, 7)
  assert.equal(state.templates.length, 4)
  assert.equal(state.schemaStatus.stale, state.schemaStatus.current !== null && state.schemaStatus.current !== state.schemaStatus.table)
  await controller.disposeAll()
})

await checkAsync("acceptance: previously missing rows save and mount", async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  const saved = await controller.save({
    id: 'coverage',
    name: 'Coverage',
    rows: [
      '@deepseek-ai/dsh-time-context',
      '@deepseek-ai/dsh-agent-instructions',
      '@deepseek-ai/dsh-command-goal',
      '@deepseek-ai/dsh-tool-schedule'
    ],
    prompt: { fragmentIds: [], text: 'Persona' }
  })
  assert.equal(saved.saved.registered, true)
  const definition = service.live.get('coverage')
  assert.deepEqual(
    definition.plugins.map((row) => row.name),
    [
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-time-context',
      '@deepseek-ai/dsh-agent-instructions',
      '@deepseek-ai/dsh-command-goal',
      '@deepseek-ai/dsh-tool-schedule'
    ]
  )
  // Required fields carry the official default, so mounting does not fail.
  const instructions = definition.plugins.find((row) => row.name === '@deepseek-ai/dsh-agent-instructions')
  assert.equal(instructions.config.maxBytes, 65536)
  await controller.disposeAll()
  assert.deepEqual(service.disposed, ['coverage'])
})

await checkAsync("acceptance: generated table covers every shipped preset row", async () => {
  const { readFile } = await import('node:fs/promises')
  const table = JSON.parse(await readFile(new URL('../lib/row-schemas.json', import.meta.url), 'utf8'))
  const rows = Object.entries(table.rows)
  assert.equal(rows.length, 35)
  assert.deepEqual(rows.filter(([, row]) => row.unresolved).map(([name]) => name), [])
  assert.match(table.dsh, /^0\./)
  assert.match(table.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  for (const [name, row] of rows) {
    assert.ok(Array.isArray(row.fields), `${name}: fields`)
    assert.ok(Array.isArray(row.tools), `${name}: tools`)
    assert.equal(row.hasConfig, row.fields.length > 0, `${name}: hasConfig`)
  }
  assert.ok(rows.filter(([, row]) => row.fields.length > 0).length >= 25)
  // Enums carry their choices when the schema spells them out; defaults are
  // real literals now, not source text.
  const fieldOf = (name, key) => table.rows[name].fields.find((field) => field.key === key)
  assert.deepEqual(fieldOf('@deepseek-ai/dsh-tool-ask-user', 'mode').options, ['legacy', 'timed'])
  assert.deepEqual(fieldOf('@deepseek-ai/dsh-tool-jobs', 'completionDelivery').options, ['quiet', 'wakeup'])
  assert.deepEqual(fieldOf('@deepseek-ai/dsh-terminal-bash', 'shellDialect').options, ['bash', 'pwsh'])
  assert.equal(fieldOf('@deepseek-ai/dsh-tool-fs', 'write').default, true)
  assert.equal(fieldOf('@deepseek-ai/dsh-tool-jobs', 'waitTimeoutMs').default, 30000)
  assert.equal(fieldOf('@deepseek-ai/dsh-tool-fs', 'readLimit').default, null)
  assert.ok(rows.filter(([, row]) => row.tools.length > 0).length >= 15)
  assert.equal(table.templates.length, 4)
  assert.ok(table.templates.every((template) => template.rows.length > 0))
  // The delegation template names the providers the Host registers for it.
  const delegation = table.templates.find((template) => template.id === 'delegation')
  const providers = delegation.rows
    .filter((row) => row.name.endsWith('dsh-tool-subagent'))
    .map((row) => row.config.provider)
    .sort()
  assert.deepEqual(providers, ['fork', 'spawn'])
})

await checkAsync("raw rows reject a missing required config key", async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  await assert.rejects(
    () => controller.save({ id: 'missing', plugins: [{ name: '@deepseek-ai/dsh-agent-instructions', config: {} }] }),
    /第 1 行 @deepseek-ai\/dsh-agent-instructions 缺少必填项 maxBytes/
  )
  assert.equal(service.live.has('missing'), false)
  await assert.rejects(
    () => controller.save({
      id: 'group-missing',
      plugins: [{
        name: 'cordis:group',
        group: true,
        isolate: { planMode: true },
        config: [{ name: '@deepseek-ai/dsh-plan-mode', config: {} }]
      }]
    }),
    /第 1 行组内第 1 行 @deepseek-ai\/dsh-plan-mode 缺少必填项 section/
  )
  const saved = await controller.save({
    id: 'required-ok',
    plugins: [{ name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } }]
  })
  assert.equal(saved.saved.registered, true)
  await controller.disposeAll()
})

await checkAsync("complete preset writes a whole-prompt persona row", async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  await controller.save({
    id: 'whole',
    complete: true,
    rows: ['@deepseek-ai/dsh-time-context'],
    prompt: { fragmentIds: ['frag-a'], text: 'Whole prompt', suffix: 'tail' }
  })
  const stored = store.doc.presets[0]
  assert.equal(stored.complete, true)
  // A complete preset is one whole prompt: fragments and suffix do not apply.
  assert.deepEqual(stored.prompt.fragmentIds, [])
  assert.equal(stored.prompt.suffix, '')
  const definition = service.live.get('whole')
  const persona = definition.plugins.find((row) => row.name === '@deepseek-ai/dsh-persona')
  assert.equal(persona.config.complete, true)
  assert.equal(persona.config.includeRuntimeContext, false)
  assert.equal(persona.config.prefix, 'Whole prompt')
  assert.equal(persona.config.suffix, undefined)
  await assert.rejects(
    () => controller.save({ id: 'whole-empty', complete: true, rows: [], prompt: { fragmentIds: [], text: '   ' } }),
    /完整提示词不能为空/
  )
  const state = await controller.state()
  assert.equal(state.presets.find((preset) => preset.id === 'whole').complete, true)
  await controller.disposeAll()
})

await checkAsync("text above the limit is rejected instead of truncated", async () => {
  const controller = mod.createAgentPresets({ store: fakeStore() })
  await controller.attach(fakeService())
  const state = await controller.state()
  assert.equal(state.limits.text, 50_000)
  assert.equal(state.limits.rows, 64)
  const huge = 'x'.repeat(50_001)
  await assert.rejects(
    () => controller.save({ id: 'too-long', rows: [], complete: true, prompt: { fragmentIds: [], text: huge } }),
    /提示词正文 50001 字，超过 50000 字上限/
  )
  await controller.disposeAll()
})

await checkAsync("copied complete prompts keep long text", async () => {
  const store = fakeStore()
  const service = fakeService()
  const controller = mod.createAgentPresets({ store })
  await controller.attach(service)
  const prefix = 'x'.repeat(40_000)
  const saved = await controller.save({
    id: 'copy-complete',
    plugins: [{
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix, complete: true, includeRuntimeContext: false }
    }]
  })
  assert.equal(saved.saved.registered, true)
  const stored = store.doc.presets[0]
  assert.equal(stored.complete, false)
  assert.equal(stored.plugins[0].config.prefix.length, 40_000)
  assert.equal(stored.plugins[0].config.complete, true)
  await controller.disposeAll()
})

await checkAsync("copied persona text obeys the same cap", async () => {
  const controller = mod.createAgentPresets({ store: fakeStore() })
  await controller.attach(fakeService())
  await assert.rejects(
    () => controller.save({
      id: 'copy-too-long',
      plugins: [{ name: '@deepseek-ai/dsh-persona', config: { prefix: 'x'.repeat(50_001), complete: true } }]
    }),
    /提示词正文 50001 字，超过 50000 字上限/
  )
  await controller.disposeAll()
})

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`)
  process.exitCode = 1
} else {
  console.log('\nall agent-preset checks passed')
}
