/**
 * Data-directory migration checks. The migration itself runs at DSH startup;
 * these tests cover scheduling validation, copying, verification, cleanup and
 * the pending-migration marker without needing the whole plugin context.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupDataDirs,
  copyDataDirs,
  hasMeaningfulData,
  hasOwnedData,
  migratePending,
  migrationPathError,
  targetHasContents,
  targetHasUnexpectedContents
} from '../lib/migrate.js'
import { WORKSPACE_WARNING_FILE, ensureOwnerMarker } from '../lib/workspace-warning.js'
import { createApi } from '../lib/api.js'
import { Store } from '../lib/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-migrate-'))
const oldDir = path.join(root, 'old')
const newDir = path.join(root, 'new')
const bootstrap = path.join(root, 'bootstrap')

function write (file, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

write(path.join(oldDir, 'library', 'sections.json'), '{"version":2,"fragments":[]}')
write(path.join(oldDir, 'library', 'messages.json'), '{"version":1,"entries":[]}')
write(path.join(oldDir, 'library', 'sections.v1.bak-test.json'), 'legacy')
write(path.join(oldDir, 'library', 'ignore.tmp'), 'tmp')
write(path.join(oldDir, 'sessions', 's1', 'state.json'), '{"enabled":true}')
write(path.join(oldDir, 'sessions', 's1', 'backups', 'a.json'), '{"version":2}')
write(path.join(oldDir, 'drafts', 's1.json'), '{"version":1}')
write(path.join(oldDir, WORKSPACE_WARNING_FILE), 'auto warning')
write(path.join(oldDir, 'config.json'), '{"keep":true}')
write(path.join(oldDir, 'unrelated.txt'), 'keep me')
ensureOwnerMarker({ dataDir: oldDir })

assert.equal(migrationPathError(oldDir, oldDir), '新旧数据目录相同')
assert.equal(migrationPathError(oldDir, path.join(oldDir, 'nested')), '新旧数据目录不能互相包含')
assert.equal(migrationPathError(oldDir, newDir), null)
assert.equal(migrationPathError(oldDir, path.parse(oldDir).root) !== null, true)
assert.equal(targetHasContents(newDir), false)
assert.equal(targetHasContents(oldDir), true)
write(path.join(newDir, WORKSPACE_WARNING_FILE), 'plugin warning')
assert.equal(targetHasContents(newDir), false, 'the generated warning file is not user data')
assert.equal(targetHasUnexpectedContents(newDir), false)
assert.equal(hasOwnedData(newDir), false)
assert.equal(hasOwnedData(oldDir), true)
assert.equal(hasMeaningfulData(newDir), false)

// A session state containing only the auto-captured baseline is not meaningful
// user data; this is the state a pre-migration empty target has.
const lightDir = path.join(root, 'light-target')
write(path.join(lightDir, 'sessions', 's1', 'state.json'), JSON.stringify({
  enabled: false,
  overrides: {},
  extras: [],
  lastPreset: null,
  presetModified: false,
  lastCapture: { names: ['harness:identity'] }
}))
assert.equal(hasMeaningfulData(lightDir), false)
write(path.join(lightDir, 'library', 'sections.json'), '{}')
assert.equal(hasMeaningfulData(lightDir), true)

const copied = copyDataDirs(oldDir, newDir)
assert.equal(copied.ok, true)
assert.deepEqual([...copied.copied].sort(), ['drafts', 'library', 'sessions'])
assert.equal(copied.files, 6)
assert.equal(fs.existsSync(path.join(newDir, 'library', 'sections.json')), true)
assert.equal(fs.existsSync(path.join(newDir, 'library', 'messages.json')), true)
assert.equal(fs.existsSync(path.join(newDir, 'library', 'ignore.tmp')), false)
assert.equal(fs.existsSync(path.join(newDir, 'config.json')), false)
assert.equal(fs.existsSync(path.join(newDir, 'unrelated.txt')), false)
assert.equal(fs.readFileSync(path.join(newDir, WORKSPACE_WARNING_FILE), 'utf8'), 'auto warning')
assert.equal(targetHasContents(newDir), true)

const cleaned = cleanupDataDirs(oldDir, { currentDir: newDir })
assert.equal(cleaned.ok, true)
assert.deepEqual([...cleaned.removed].sort(), ['drafts', 'library', 'sessions'])
assert.equal(cleaned.warningRemoved, true)
assert.equal(fs.existsSync(path.join(oldDir, WORKSPACE_WARNING_FILE)), false)
assert.equal(fs.existsSync(path.join(oldDir, 'config.json')), true)
assert.equal(fs.existsSync(path.join(oldDir, 'unrelated.txt')), true)
assert.equal(fs.existsSync(path.join(oldDir, 'library')), false)

assert.equal(cleanupDataDirs(newDir, { currentDir: newDir }).ok, false)

// A target that is the bootstrap directory may contain config.json; only the
// data subdirectories count as "contents".
fs.mkdirSync(bootstrap, { recursive: true })
write(path.join(bootstrap, 'config.json'), '{}')
assert.equal(targetHasContents(bootstrap, { bootstrapDir: bootstrap }), false)
write(path.join(bootstrap, 'library', 'sections.json'), '{}')
assert.equal(targetHasContents(bootstrap, { bootstrapDir: bootstrap }), true)

// Pending migration: copy, record previousDataDir, clear marker, write config.
const old2 = path.join(root, 'old2')
const new2 = path.join(root, 'new2')
write(path.join(old2, 'library', 'sections.json'), '{}')
write(path.join(old2, 'sessions', 's2', 'state.json'), '{}')
const settings = {
  dataDir: new2,
  pendingMigration: { from: old2, to: new2, at: 1 }
}
let written = null
const migrated = migratePending(settings, {
  bootstrapDir: bootstrap,
  writeConfig: (value) => { written = value }
})
assert.equal(migrated.ok, true)
assert.equal(migrated.files, 2)
assert.equal(settings.pendingMigration, undefined)
assert.equal(settings.previousDataDir, old2)
assert.equal(written, settings)
assert.equal(fs.existsSync(path.join(new2, 'library', 'sections.json')), true)

// Source already gone: clear the pending marker without claiming an old dir.
// Use a bootstrap dir with no meaningful data, otherwise the fallback source
// recovery would legitimately copy that data instead.
const emptyBootstrap = path.join(root, 'empty-bootstrap')
write(path.join(emptyBootstrap, 'config.json'), '{}')
const missingSettings = {
  dataDir: path.join(root, 'new3'),
  pendingMigration: { from: path.join(root, 'missing'), to: path.join(root, 'new3'), at: 1 }
}
const missing = migratePending(missingSettings, { bootstrapDir: emptyBootstrap, writeConfig: () => {} })
assert.equal(missing.ok, true)
assert.equal(missing.sourceMissing, true)
assert.equal(missingSettings.pendingMigration, undefined)
assert.equal(missingSettings.previousDataDir, undefined)

// An empty recorded source falls back to meaningful bootstrap data.
const fallbackBootstrap = path.join(root, 'fallback-bootstrap')
const emptySource = path.join(root, 'empty-source')
const fallbackTarget = path.join(root, 'fallback-target')
write(path.join(fallbackBootstrap, 'library', 'sections.json'), '{"version":2,"fragments":[]}')
write(path.join(emptySource, 'sessions', 's1', 'state.json'), JSON.stringify({ enabled: false, lastCapture: { names: [] } }))
const fallbackSettings = {
  dataDir: fallbackTarget,
  pendingMigration: { from: emptySource, to: fallbackTarget, at: 1 }
}
const fallback = migratePending(fallbackSettings, {
  bootstrapDir: fallbackBootstrap,
  writeConfig: () => {}
})
assert.equal(fallback.ok, true)
assert.equal(fallback.from, fallbackBootstrap)
assert.equal(fallbackSettings.previousDataDir, fallbackBootstrap)
assert.equal(fs.existsSync(path.join(fallbackTarget, 'library', 'sections.json')), true)

// Nested paths are rejected before any copy.
const nestedSettings = {
  dataDir: path.join(old2, 'nested'),
  pendingMigration: { from: old2, to: path.join(old2, 'nested'), at: 1 }
}
const nested = migratePending(nestedSettings, { bootstrapDir: bootstrap, writeConfig: () => {} })
assert.equal(nested.ok, false)
assert.match(nested.error, /包含/)

// Full wipe removes all plugin data but keeps config.json in the same dir.
const wipeDir = path.join(root, 'wipe')
const wipeStore = new Store(wipeDir, [], () => ({ autoBackupLimit: 20, manualBackupLimit: 5 }))
wipeStore.ensure()
write(path.join(wipeDir, 'config.json'), '{"keep":true}')
wipeStore.saveLibrary({ version: 2, fragments: [{ id: 'f1', key: 'harness:identity', label: 'x', mode: 'replace', text: 'x' }] })
wipeStore.savePresets({ version: 1, presets: [{ id: 'p1', name: 'p', fragmentIds: ['f1'] }] })
wipeStore.saveState('s1', { ...wipeStore.state('s1'), enabled: true })
write(path.join(wipeDir, 'sessions', 's1', 'backups', 'a.json'), '{}')
wipeStore.saveDraft('s1', { state: { enabled: true }, fragments: [] })
write(path.join(wipeDir, 'pending', 's1.json'), '{}')
write(path.join(wipeDir, WORKSPACE_WARNING_FILE), 'warning')
const wiped = wipeStore.wipeAll()
assert.deepEqual([...wiped.removed].sort(), ['drafts', 'library', 'pending', 'sessions'])
assert.equal(wiped.warningRemoved, true)
assert.equal(fs.existsSync(path.join(wipeDir, WORKSPACE_WARNING_FILE)), false)
assert.equal(fs.existsSync(path.join(wipeDir, 'config.json')), true)
assert.equal(wipeStore.library().fragments.length, 0)
assert.equal(wipeStore.presets().presets.length, 0)
assert.equal(wipeStore.hasDraft('s1'), false)
assert.equal(wipeStore.state('s1').overrides && Object.keys(wipeStore.state('s1').overrides).length, 0)
assert.equal(fs.existsSync(path.join(wipeDir, 'library')), true)
assert.equal(fs.existsSync(path.join(wipeDir, 'sessions')), true)
assert.equal(fs.existsSync(path.join(wipeDir, 'drafts')), true)

// API wiring: path changes schedule (never copy immediately), re-saving the
// current path cancels, non-empty targets are rejected, and cleanup removes
// only data subdirectories.
const apiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-migrate-api-'))
const currentDir = path.join(apiRoot, 'current')
const targetDir = path.join(apiRoot, 'target')
const badTarget = path.join(apiRoot, 'bad-target')
const cleanupTarget = path.join(apiRoot, 'cleanup-target')
write(path.join(currentDir, 'library', 'sections.json'), '{}')
write(path.join(badTarget, 'keep.txt'), 'x')
write(path.join(cleanupTarget, 'library', 'sections.json'), '{}')
write(path.join(cleanupTarget, 'sessions', 's1', 'state.json'), '{}')
write(path.join(cleanupTarget, 'config.json'), '{}')
write(path.join(cleanupTarget, WORKSPACE_WARNING_FILE), 'warning')
ensureOwnerMarker({ dataDir: cleanupTarget })
const apiSettings = {}
const api = createApi({
  store: {},
  engine: {},
  dataDir: currentDir,
  dataDirSource: 'bootstrap',
  warnings: [],
  settings: () => apiSettings,
  saveSettings: (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete apiSettings[key]
      else apiSettings[key] = value
    }
    return apiSettings
  }
})
const scheduled = await api.handle({ op: 'config.set', dataDir: targetDir })
assert.ok(scheduled.migration !== null)
// os.tmpdir() can be an 8.3 short path on Windows CI (RUNNER~1); the store
// normalizes with realpath, so compare resolved paths.
assert.equal(fs.realpathSync.native(scheduled.migration.from), fs.realpathSync.native(currentDir))
assert.equal(fs.realpathSync.native(scheduled.migration.to), fs.realpathSync.native(targetDir))
assert.equal(fs.realpathSync.native(apiSettings.dataDir), fs.realpathSync.native(targetDir))
assert.equal(
  fs.realpathSync.native(apiSettings.pendingMigration.to),
  fs.realpathSync.native(targetDir)
)
assert.equal(fs.existsSync(path.join(targetDir, 'library')), false)
await assert.rejects(
  () => api.handle({ op: 'config.set', dataDir: badTarget }),
  /空目录/
)
const cancelled = await api.handle({ op: 'config.set', dataDir: currentDir })
assert.equal(cancelled.migration, null)
assert.equal(apiSettings.pendingMigration, undefined)
apiSettings.previousDataDir = cleanupTarget
const apiCleaned = await api.handle({ op: 'config.cleanupOldData' })
assert.deepEqual([...apiCleaned.cleaned.removed].sort(), ['library', 'sessions'])
assert.equal(apiCleaned.cleaned.warningRemoved, true)
assert.equal(fs.existsSync(path.join(cleanupTarget, 'config.json')), true)
assert.equal(fs.existsSync(path.join(cleanupTarget, WORKSPACE_WARNING_FILE)), false)
assert.equal(apiSettings.previousDataDir, undefined)

console.log('migration checks passed')
