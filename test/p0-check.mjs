/**
 * P0 foundation checks: capability defaults, legacy mode tolerance, and
 * blank-session draft handling. No capability is applied yet.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, emptySession, normalizeCapabilityState } from '../lib/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-p0-'))
const store = new Store(root, [], () => ({ autoBackupLimit: 20, manualBackupLimit: 5 }))
store.ensure()

const fresh = emptySession()
assert.deepEqual(fresh.toolPolicy, { allow: null, deny: [] })
assert.deepEqual(fresh.transientSections, [])
assert.equal('mode' in fresh, false, 'new session state no longer creates a role mode')
assert.equal('agentPolicy' in fresh, false, 'subagent/workflow/loop policy was removed from the plan')

const legacy = normalizeCapabilityState({
  enabled: true,
  mode: 'roleplay',
  overrides: {},
  extras: []
})
assert.equal(legacy.mode, 'roleplay', 'legacy mode remains readable but inert')
assert.deepEqual(legacy.toolPolicy, { allow: null, deny: [] })
assert.deepEqual(legacy.transientSections, [])

const invalid = normalizeCapabilityState({
  toolPolicy: { allow: ['read', 3], deny: 'no' },
  transientSections: 'no'
})
assert.deepEqual(invalid.toolPolicy, { allow: ['read'], deny: [] })
assert.deepEqual(invalid.transientSections, [])

const draft = store.saveDraft('blank-1', { state: { enabled: true } })
assert.equal(draft.state.committed, false)
assert.deepEqual(draft.state.toolPolicy, { allow: null, deny: [] })
assert.deepEqual(draft.state.transientSections, [])
assert.equal(fs.existsSync(path.join(root, 'sessions', 'blank-1', 'state.json')), false)

const ensured = store.ensureDraft('blank-2')
assert.equal(ensured.state.committed, false)
assert.deepEqual(ensured.state.toolPolicy, { allow: null, deny: [] })
assert.equal(fs.existsSync(path.join(root, 'sessions', 'blank-2', 'state.json')), false)

// Old state files normalize on read without rewriting the file.
fs.mkdirSync(path.join(root, 'sessions', 'legacy-1'), { recursive: true })
fs.writeFileSync(path.join(root, 'sessions', 'legacy-1', 'state.json'), JSON.stringify({
  version: 1,
  enabled: true,
  mode: 'roleplay',
  overrides: {},
  extras: []
}))
const old = store.state('legacy-1')
assert.equal(old.mode, 'roleplay')
assert.deepEqual(old.toolPolicy, { allow: null, deny: [] })
assert.deepEqual(old.transientSections, [])

console.log('P0 checks passed')
