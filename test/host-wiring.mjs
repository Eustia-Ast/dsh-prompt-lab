/**
 * Wiring check: runs the Host plugin against a fake Cordis context and drives
 * the HTTP handler end to end. It verifies the lifecycle this version depends
 * on: no assembly waterfall listener, one `agent/created` sample, scoped
 * `section()` registrations, and disposal on `agent/disposed`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { WORKSPACE_WARNING_FILE } from '../lib/workspace-warning.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-wire-'))
const listeners = new Map()
const routes = []
const logs = []

const webCtx = {
  effect (fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  webServer: {
    register (route) {
      routes.push(route)
      return () => {}
    }
  }
}

const live = new Map()

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
      return { HARNESS_IDENTITY: -1000, TOOL_BASH: 1000, TOOL_READ: 1100 }[key]
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

function makeTools () {
  const all = ['bash', 'read', 'web_search', 'subagent', 'workflow']
  const denied = new Set()
  return {
    restrict (filter) {
      for (const name of filter?.deny ?? []) {
        if (!all.includes(name)) throw new Error(`unknown global tool ${name}`)
        denied.add(name)
      }
      return () => {
        for (const name of filter?.deny ?? []) denied.delete(name)
      }
    },
    schemas (scope) {
      const names = scope === undefined ? all : all.filter((name) => !denied.has(name))
      return names.map((name) => ({
        name,
        description: `${name} description`,
        parameters: { type: 'object', properties: {} }
      }))
    },
    get (name) {
      if (!all.includes(name)) return undefined
      if (denied.has(name)) return undefined
      return { name, description: `${name} description`, parameters: { type: 'object', properties: {} } }
    }
  }
}

function makeAgent (id) {
  const sections = [
    { name: 'harness:identity', order: -1000, text: 'identity' },
    { name: 'tool:bash', order: 1000, text: 'bash usage' }
  ]
  const prompt = makePrompt(sections)
  const session = { id }
  const tools = makeTools()
  const ctx = {
    systemPrompt: prompt,
    tools,
    get (name) {
      if (name === 'systemPrompt') return prompt
      if (name === 'tools') return tools
      return undefined
    },
    effect (fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    }
  }
  sessionsById.set(id, session)
  return { id, session, ctx }
}

const boundaries = new Map()
const sessionsById = new Map()
let stateOfCalls = 0
const ctx = {
  logger: { warn: (message) => logs.push(message) },
  on (name, handler) {
    const list = listeners.get(name) ?? []
    list.push(handler)
    listeners.set(name, list)
    return () => {}
  },
  get (name) {
    if (name === 'agents') {
      return {
        get: (id) => live.get(id),
        turnBoundaryOf: (session) => boundaries.get(session)
      }
    }
    if (name === 'sessions') return { get: (id) => sessionsById.get(id) }
    if (name === 'clientModules') return { release: { version: '0.2.2-rc.3' } }
    if (name === 'sessionProjections') {
      return {
        stateOf (session, key) {
          stateOfCalls += 1
          return key === 'turnBoundary' ? boundaries.get(session) : undefined
        }
      }
    }
    return undefined
  },
  inject (names, fn) {
    if (names.includes('webServer')) assert.deepEqual(names, ['webServer'])
    fn(webCtx)
  },
  effect (fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  }
}

apply(ctx, { dataDir: dir })

assert.equal(routes.length, 1)
assert.equal(routes[0].kind, 'prefix')
assert.equal(routes[0].path, '/prompt-lab/api')
assert.equal((listeners.get('system-prompt/assemble') ?? []).length, 0, 'the waterfall listener must be gone')
assert.equal((listeners.get('agent/created') ?? []).length, 1)
assert.equal((listeners.get('agent/disposed') ?? []).length, 1)
assert.equal((listeners.get('agent-preset/selected') ?? []).length, 1)
assert.equal((listeners.get('agent/pre-step') ?? []).length, 1)

function req (op, payload) {
  const body = Buffer.from(JSON.stringify({ op, ...payload }))
  const request = {
    method: 'POST',
    url: '/prompt-lab/api',
    headers: {
      host: 'localhost',
      origin: 'http://localhost',
      'content-type': 'application/json'
    },
    socket: { remoteAddress: '127.0.0.1' },
    on (event, cb) {
      if (event === 'data') cb(body)
      if (event === 'end') cb()
    },
    destroy () {}
  }
  let out = ''
  const response = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (value) { out = value }
  }
  return routes[0].handler(request, response).then(() => JSON.parse(out))
}

const agent = makeAgent('session-wire-1')
boundaries.set(agent.session, { openTurnStartSeq: 1, lastTurn: 1 })
live.set(agent.id, agent)

// Enable before the agent exists: state only, no registration possible yet.
const enabled = await req('session.set', { sessionId: agent.id, enabled: true })
assert.equal(enabled.ok, true)
assert.equal(enabled.value.session.enabled, true)

// Simulate the Harness announcing the agent; the listener samples and registers.
const created = listeners.get('agent/created')[0]
await created({ agent })
assert.equal(fs.existsSync(path.join(dir, WORKSPACE_WARNING_FILE)), true, 'workspace warning file must be created')
assert.match(fs.readFileSync(path.join(dir, WORKSPACE_WARNING_FILE), 'utf8'), /do not modify anything/)
const baseline = await agent.ctx.systemPrompt.assemble({ agent, scope: agent })
assert.equal(baseline.sections.length, 2)
assert.equal(baseline.sections[1].text, 'bash usage')

// P1: per-session tool switches, exact tool:<name> section suppression, and
// removal when the session toggle is off.
const toolsBefore = await req('tools.list', { sessionId: agent.id })
assert.equal(toolsBefore.ok, true)
assert.ok(toolsBefore.value.tools.some((tool) => tool.name === 'bash' && tool.global === true))

const toolsDenied = await req('tools.set', { sessionId: agent.id, deny: ['bash', 'web_search'] })
assert.equal(toolsDenied.ok, true)
assert.deepEqual(toolsDenied.value.tools.policy.deny.sort(), ['bash', 'web_search'])
assert.deepEqual(agent.ctx.tools.schemas(agent).map((tool) => tool.name), ['read', 'subagent', 'workflow'])
const suppressedBaseline = await agent.ctx.systemPrompt.assemble({ agent, scope: agent })
assert.equal(suppressedBaseline.sections.find((section) => section.name === 'tool:bash').text, '')

const toolsRestored = await req('tools.set', { sessionId: agent.id, deny: [] })
assert.equal(toolsRestored.ok, true)
assert.ok(agent.ctx.tools.schemas(agent).some((tool) => tool.name === 'bash'))
assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent }))
  .sections.find((section) => section.name === 'tool:bash').text, 'bash usage')

await req('tools.set', { sessionId: agent.id, deny: ['bash'] })
await req('session.set', { sessionId: agent.id, enabled: false })
assert.ok(agent.ctx.tools.schemas(agent).some((tool) => tool.name === 'bash'))
await req('session.set', { sessionId: agent.id, enabled: true })
assert.ok(!agent.ctx.tools.schemas(agent).some((tool) => tool.name === 'bash'))
assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent }))
  .sections.find((section) => section.name === 'tool:bash').text, '')
await req('tools.set', { sessionId: agent.id, deny: [] })

const readOnlyRejected = await req('fragment.save', { sessionId: agent.id, key: 'tool:bash', text: 'never bash', mode: 'replace' })
assert.equal(readOnlyRejected.ok, false)

const saved = await req('fragment.save', { sessionId: agent.id, key: 'harness:identity', text: 'never identity', mode: 'replace' })
assert.equal(saved.ok, false, 'started sessions must be prompt-locked')
const rewritten = await agent.ctx.systemPrompt.assemble({ agent, scope: agent })
assert.notEqual(rewritten.sections[0].text, 'never identity')

// Explicit recapture still returns the official baseline.
const recaptured = await req('assemble.capture', { sessionId: agent.id })
assert.equal(recaptured.ok, true)
assert.equal(recaptured.value.capture.ok, true)
assert.equal(recaptured.value.prompt.sections.length, 2)
assert.notEqual((await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).sections[0].text, 'never identity')

// Disposal removes the scoped registration.
listeners.get('agent/disposed')[0]({ agent })
assert.equal((await agent.ctx.systemPrompt.assemble({ agent, scope: agent })).sections[1].text, 'bash usage')

// A blank window keeps edits in a draft; the first pre-step commits them.
const draftAgent = makeAgent('session-wire-draft')
boundaries.set(draftAgent.session, { openTurnStartSeq: null, lastTurn: 0 })
live.set(draftAgent.id, draftAgent)
await listeners.get('agent/created')[0]({ agent: draftAgent })
assert.equal(stateOfCalls, 0, '0.2.2 AgentRegistry turnBoundaryOf should be used')
const draftEnabled = await req('session.set', { sessionId: draftAgent.id, enabled: true })
assert.equal(draftEnabled.value.session.draft, true)
assert.equal(draftEnabled.value.session.enabled, true)
assert.equal(fs.existsSync(path.join(dir, 'drafts', `${draftAgent.id}.json`)), true)
assert.equal(fs.existsSync(path.join(dir, 'sessions', draftAgent.id, 'state.json')), false)

const draftTools = await req('tools.set', { sessionId: draftAgent.id, deny: ['web_search'] })
assert.equal(draftTools.value.session.draft, true)
assert.deepEqual(draftTools.value.tools.policy.deny, ['web_search'])
assert.ok(!draftAgent.ctx.tools.schemas(draftAgent).some((tool) => tool.name === 'web_search'))
assert.equal(fs.existsSync(path.join(dir, 'sessions', draftAgent.id, 'state.json')), false)

const draftSaved = await req('fragment.save', {
  sessionId: draftAgent.id,
  key: 'harness:identity',
  mode: 'replace',
  text: 'draft identity'
})
assert.equal(draftSaved.value.session.draft, true)
assert.equal(draftSaved.value.library.fragments.find((fragment) => fragment.text === 'draft identity').draft, false)
const draftLibrary = await req('library.list', { sessionId: draftAgent.id })
const draftLibraryTemplate = draftLibrary.value.fragments.find((fragment) => fragment.preview === 'draft identity')
assert.ok(draftLibraryTemplate !== undefined)
assert.equal(draftLibraryTemplate.usage.sessions.length, 0)

let stepped = false
const decision = await listeners.get('agent/pre-step')[0]({ agent: draftAgent }, async () => {
  stepped = true
  return { kind: 'enter', messages: [] }
})
assert.equal(stepped, true, 'pre-step must always continue')
assert.equal(decision.kind, 'enter')
assert.equal(fs.existsSync(path.join(dir, 'drafts', `${draftAgent.id}.json`)), false)
assert.equal(fs.existsSync(path.join(dir, 'sessions', draftAgent.id, 'state.json')), true)
const committed = await req('state.get', { sessionId: draftAgent.id })
assert.equal(committed.value.session.draft, false)
assert.equal(committed.value.session.committed, true)
assert.ok(committed.value.backups.auto.length > 0)
const committedTools = await req('tools.list', { sessionId: draftAgent.id })
assert.deepEqual(committedTools.value.policy.deny, ['web_search'])
assert.ok(!draftAgent.ctx.tools.schemas(draftAgent).some((tool) => tool.name === 'web_search'))
const committedLibrary = await req('library.list', { sessionId: draftAgent.id })
const committedTemplate = committedLibrary.value.fragments.find((fragment) => fragment.preview === 'draft identity')
assert.ok(committedTemplate !== undefined)
assert.ok(committedTemplate.usage.sessions.some((entry) => entry.id === draftAgent.id))

// Disposing a still-blank window keeps the draft and records the close time.
const closedAgent = makeAgent('session-wire-closed')
boundaries.set(closedAgent.session, { openTurnStartSeq: null, lastTurn: 0 })
live.set(closedAgent.id, closedAgent)
await listeners.get('agent/created')[0]({ agent: closedAgent })
await req('session.set', { sessionId: closedAgent.id, enabled: true })
const closedPath = path.join(dir, 'drafts', `${closedAgent.id}.json`)
listeners.get('agent/disposed')[0]({ agent: closedAgent })
assert.equal(fs.existsSync(closedPath), true)
assert.ok(JSON.parse(fs.readFileSync(closedPath, 'utf8')).closedAt > 0)

// A blank window without a live Agent can still create a draft when the
// session object and its turnBoundary projection exist.
const idleId = 'session-wire-noagent'
const idleSession = { id: idleId }
sessionsById.set(idleId, idleSession)
boundaries.set(idleSession, { openTurnStartSeq: null, lastTurn: 0 })
const idleEnabled = await req('session.set', { sessionId: idleId, enabled: true })
assert.equal(idleEnabled.value.session.draft, true)
assert.equal(fs.existsSync(path.join(dir, 'drafts', `${idleId}.json`)), true)
assert.equal(fs.existsSync(path.join(dir, 'sessions', idleId, 'state.json')), false)

// A live session used by the AGENTS read-only check below.
const instructionsAgent = makeAgent('session-wire-instructions')
boundaries.set(instructionsAgent.session, { openTurnStartSeq: 1, lastTurn: 1 })
live.set(instructionsAgent.id, instructionsAgent)
await listeners.get('agent/created')[0]({ agent: instructionsAgent })
await req('session.set', { sessionId: instructionsAgent.id, enabled: true })

// List messages and append a user message to the live session.
const messageAgent = makeAgent('session-wire-messages')
boundaries.set(messageAgent.session, { openTurnStartSeq: 1, lastTurn: 1 })
const storedMessages = []
messageAgent.session.deriveMessages = () => storedMessages
messageAgent.session.append = (type, data) => {
  if (Array.isArray(type)) {
    for (const [eventType, eventData] of type) {
      if (eventType === 'user/message') storedMessages.push(eventData)
      else if (eventType === 'assistant/message') storedMessages.push(eventData.message)
    }
    return []
  }
  storedMessages.push(type === 'assistant/message' ? data.message : data)
  return { type, data }
}
messageAgent.followup = (message) => { storedMessages.push(message) }
messageAgent.runMaintenance = async (job) => { await job() }
live.set(messageAgent.id, messageAgent)
await listeners.get('agent/created')[0]({ agent: messageAgent })
await req('session.set', { sessionId: messageAgent.id, enabled: true })
storedMessages.push({
  id: 'existing-user',
  role: 'user',
  content: [{ type: 'text', text: 'existing question' }],
  source: { kind: 'user' }
})
const appended = await req('messages.appendUser', { sessionId: messageAgent.id, text: 'follow up' })
assert.equal(appended.value.ok, true)
assert.equal(storedMessages.length, 2)
assert.equal(storedMessages[1].content[0].text, 'follow up')
assert.equal(storedMessages[1].source.kind, 'user')
const userTexts = await req('messages.text.list', { sessionId: messageAgent.id })
assert.equal(userTexts.value.entries.some((entry) => entry.text === 'follow up'), true)

messageAgent.model = { current: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
const appendedAssistant = await req('messages.appendAssistant', { sessionId: messageAgent.id, text: 'assistant reply' })
assert.equal(appendedAssistant.value.ok, true)
const appendTexts = await req('messages.text.list', { sessionId: messageAgent.id })
assert.equal(appendTexts.value.entries.some((entry) => entry.text === 'assistant reply'), true)
assert.equal(storedMessages.length, 3)
assert.equal(storedMessages[2].role, 'assistant')
assert.equal(storedMessages[2].content[0].text, 'assistant reply')
assert.equal(storedMessages[2].source.kind, 'model')
assert.equal(storedMessages[2].source.provider, 'deepseek-official')
assert.equal(appendedAssistant.value.reloadRequired, true)
const pendingAfterAppend = await req('pending.status', { sessionId: messageAgent.id })
assert.equal(pendingAfterAppend.value.pending, true)
assert.equal(pendingAfterAppend.value.kind, 'append')

const sentPrefill = await req('prefill.send', {
  sessionId: messageAgent.id,
  text: 'user before prefill',
  assistantText: 'prefill assistant'
})
assert.equal(sentPrefill.value.ok, true)
assert.equal(sentPrefill.value.reloadRequired, true)
const prefillTexts = await req('messages.text.list', { sessionId: messageAgent.id })
assert.equal(prefillTexts.value.entries.some((entry) => entry.text === 'user before prefill'), true)
assert.equal(prefillTexts.value.entries.some((entry) => entry.text === 'prefill assistant'), true)
assert.equal(storedMessages.length, 5)
assert.equal(storedMessages[3].role, 'user')
assert.equal(storedMessages[3].content[0].text, 'user before prefill')
assert.equal(storedMessages[4].role, 'assistant')
assert.equal(storedMessages[4].content[0].text, 'prefill assistant')
const pendingAfterPrefill = await req('pending.status', { sessionId: messageAgent.id })
assert.equal(pendingAfterPrefill.value.pending, true)
assert.equal(pendingAfterPrefill.value.kind, 'prefill')


boundaries.set(messageAgent.session, { openTurnStartSeq: null, lastTurn: 0 })
const noTurnPrefill = await req('prefill.send', { sessionId: messageAgent.id, text: 'before first turn' })
assert.equal(noTurnPrefill.value.ok, false)
assert.equal(noTurnPrefill.value.reason, 'no-turn')
boundaries.set(messageAgent.session, { openTurnStartSeq: 1, lastTurn: 1 })

// AGENTS files are exposed read-only from the session cwd.
const instructionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-agents-'))
fs.writeFileSync(path.join(instructionsDir, 'AGENTS.md'), 'workspace instructions')
instructionsAgent.session.header = { cwd: instructionsDir }
const instructions = await req('agents.read', { sessionId: instructionsAgent.id })
assert.equal(instructions.value.ok, true)
assert.ok(instructions.value.files.some((file) => file.text.includes('workspace instructions')))

// Unknown route / method are handled, not thrown.
const health = await routes[0].handler(
  { method: 'GET', url: '/prompt-lab/api/health' },
  { setHeader () {}, end (value) { this.value = value } }
)
assert.equal(health, undefined)

assert.ok(logs.every((message) => /只读|锁定/.test(message)))
console.log('host wiring checks passed')
