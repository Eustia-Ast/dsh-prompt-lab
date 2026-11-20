/**
 * 1.1.0: archived/missing session cleanup must never remove live/saved data.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../lib/store.js'
import { createApi } from '../lib/api.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-purge-'))
const warnings = []
try {
  const store = new Store(dir, warnings)
  store.ensure()
  for (const id of ['live', 'saved', 'archived', 'missing']) {
    store.saveState(id, { enabled: true })
  }

  const statuses = new Map([
    ['live', 'live'],
    ['saved', 'saved'],
    ['archived', 'archived'],
    ['missing', 'missing']
  ])
  const api = createApi({
    store,
    engine: {},
    dataDir: dir,
    dataDirSource: 'test',
    warnings,
    livenessOf: async (ids) => new Map(ids.map((id) => [id, {
      id,
      status: statuses.get(id) ?? 'unknown',
      title: null
    }])),
    purgeSessionData: (id) => store.deleteSessionData(id),
    settings: () => ({}),
    saveSettings: () => {}
  })

  const preview = await api.handle({ op: 'config.purgeArchived', preview: true })
  assert.deepEqual(preview.targets.sort(), ['archived', 'missing'])
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'archived')), true)
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'missing')), true)

  const result = await api.handle({ op: 'config.purgeArchived' })
  assert.deepEqual(result.removed.sort(), ['archived', 'missing'])
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'archived')), false)
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'missing')), false)
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'live')), true)
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'saved')), true)
  console.log('purge checks passed')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
