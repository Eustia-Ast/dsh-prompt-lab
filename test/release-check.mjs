/**
 * Release-candidate regression checks for the fixes applied in this tree.
 * These are deliberately small and focused; the broader behavioural suites
 * still run beside them.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { SESSION_ID, Store, DEFAULT_CONFIG, bootstrapDir, resolveDshHome, validateDataDir } from '../lib/store.js'
import { createApi, createHandler, ROUTE } from '../lib/api.js'
import { createEngine } from '../lib/engine.js'
import { DATA_SUBDIRS, cleanupDataDirs, copyDataDirs, targetHasUnexpectedContents, migrationPathError } from '../lib/migrate.js'
import {
  OWNER_MARKER_FILE,
  WORKSPACE_WARNING_FILE,
  ensureOwnerMarker,
  ensureWorkspaceWarning,
  isOwnedDataDir
} from '../lib/workspace-warning.js'

function tempDir (name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `plab-release-${name}-`))
  return dir
}

function makeStore (dir) {
  const warnings = []
  const settings = { ...DEFAULT_CONFIG }
  const store = new Store(dir, warnings, () => settings)
  store.ensure()
  return { store, warnings, settings }
}

// Windows junctions need no SeCreateSymbolicLinkPrivilege, unlike `dir`
// symlinks. Use a junction there so the guard test runs on an ordinary
// Windows account.
function linkDir (target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return false
    throw error
  }
}

function linkFile (target, link) {
  try {
    fs.symlinkSync(target, link)
    return true
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return false
    throw error
  }
}

// ---------------------------------------------------------------- session ids
assert.equal(SESSION_ID.test('..'), false, 'parent segment must be rejected')
assert.equal(SESSION_ID.test('.'), false, 'current segment must be rejected')
assert.equal(SESSION_ID.test('.hidden'), false, 'leading dot must be rejected')
assert.equal(SESSION_ID.test('session-0123'), true)
{
  const dir = tempDir('id')
  const { store } = makeStore(dir)
  assert.throws(() => store.sessionDir('..'), /invalid session id/)
  assert.throws(() => store.statePath('../escape'), /invalid session id/)
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false)
}

// ------------------------------------------------------ store symlink guards
{
  const data = tempDir('store-symlink-root')
  const external = tempDir('store-symlink-external')
  if (linkDir(external, path.join(data, 'library'))) {
    const store = new Store(data, [], () => DEFAULT_CONFIG)
    assert.throws(() => store.ensure(), /symlinked storage path/)
    assert.equal(fs.readdirSync(external).length, 0, 'refusing a symlink must not write outside the data root')
  } else {
    console.log('skip: directory links are unavailable on this platform')
  }
}
{
  const data = tempDir('store-symlink-session')
  const external = tempDir('store-symlink-session-external')
  const store = makeStore(data).store
  if (linkDir(external, path.join(data, 'sessions', 'session-escape'))) {
    assert.throws(
      () => store.saveState('session-escape', { ...store.state('session-escape'), enabled: true }),
      /symlinked storage path/
    )
  } else {
    console.log('skip: directory links are unavailable on this platform')
  }
}
{
  const data = tempDir('store-symlink-library-file')
  const external = path.join(tempDir('store-symlink-library-external'), 'secrets.json')
  fs.writeFileSync(external, JSON.stringify({ fragments: [{ id: 'secret', text: 'not for prompt lab' }] }))
  const store = makeStore(data).store
  if (linkFile(external, path.join(data, 'library', 'sections.json'))) {
    assert.throws(() => store.library(), /symlinked storage path/)
  } else {
    console.log('skip: file links are unavailable on this platform')
  }
}
{
  const data = tempDir('store-symlink-backups')
  const externalDir = tempDir('store-symlink-backups-external')
  const externalFile = path.join(externalDir, 'old-auto.json')
  fs.writeFileSync(externalFile, JSON.stringify({ kind: 'auto' }))
  const store = makeStore(data).store
  const sessionDir = store.sessionDir('session-backups')
  fs.mkdirSync(sessionDir, { recursive: true })
  if (linkDir(externalDir, path.join(sessionDir, 'backups'))) {
    assert.deepEqual(store.listBackups('session-backups'), [])
    store._prune('session-backups')
    assert.equal(fs.existsSync(externalFile), true, 'backup pruning must never delete through a symlink')
  } else {
    console.log('skip: directory links are unavailable on this platform')
  }
}

// -------------------------------------------------------- symlink path guards
{
  const workspace = fs.realpathSync(process.cwd())
  const outside = tempDir('outside')
  const alias = path.join(outside, 'workspace-link')
  if (linkDir(workspace, alias)) {
    const rejected = validateDataDir(path.join(alias, 'prompt-lab-data'))
    assert.equal('error' in rejected, true, 'symlinked workspace descendants must be rejected')
    assert.match(rejected.error, /工作区/)
  } else {
    console.log('skip: directory links are unavailable on this platform')
  }
  const direct = validateDataDir(workspace)
  assert.equal('error' in direct, true, 'workspace itself must be rejected')
  assert.match(direct.error, /工作区/)
}
{
  const parent = tempDir('migration-symlink')
  const real = path.join(parent, 'real')
  fs.mkdirSync(real)
  const alias = path.join(parent, 'alias')
  if (linkDir(real, alias)) {
    assert.match(
      migrationPathError(path.join(real, 'from'), path.join(alias, 'from', 'nested')),
      /互相包含/,
      'migration overlap checks must compare canonical paths'
    )
  } else {
    console.log('skip: directory links are unavailable on this platform')
  }
}

// ------------------------------------------------------------- owner marker
{
  const dir = tempDir('owner')
  const { store } = makeStore(dir)
  assert.equal(isOwnedDataDir(dir), true)
  assert.equal(fs.existsSync(path.join(dir, OWNER_MARKER_FILE)), true)
  fs.rmSync(path.join(dir, OWNER_MARKER_FILE), { force: true })
  fs.rmSync(path.join(dir, WORKSPACE_WARNING_FILE), { force: true })
  assert.equal(isOwnedDataDir(dir), false)
  assert.throws(() => store.wipeAll(), /所有权标记/)
  assert.equal(fs.existsSync(path.join(dir, 'library')), true, 'refusal must not delete data')
}
{
  const dir = tempDir('legacy')
  fs.mkdirSync(path.join(dir, 'library'), { recursive: true })
  assert.equal(isOwnedDataDir(dir), false)
  const warning = ensureWorkspaceWarning({ dataDir: dir })
  assert.equal(warning.ok, true)
  assert.equal(isOwnedDataDir(dir), true)
}

// ------------------------------------------------------- migration/cleanup
{
  const source = tempDir('migrate-src')
  const target = tempDir('migrate-dst')
  fs.mkdirSync(path.join(source, 'library'), { recursive: true })
  fs.writeFileSync(path.join(source, 'library', 'sections.json'), '{}')
  fs.mkdirSync(path.join(source, 'pending'), { recursive: true })
  fs.writeFileSync(path.join(source, 'pending', 's.json'), '{}')
  ensureOwnerMarker({ dataDir: source })
  ensureWorkspaceWarning({ dataDir: source })
  const copied = copyDataDirs(source, target)
  assert.equal(copied.ok, true)
  assert.equal(fs.existsSync(path.join(target, 'pending', 's.json')), true, 'pending must migrate')
  assert.equal(fs.existsSync(path.join(target, OWNER_MARKER_FILE)), true, 'owner marker must migrate')
  assert.equal(targetHasUnexpectedContents(target, { bootstrapDir: bootstrapDir() }), false)
  assert.equal(DATA_SUBDIRS.includes('pending'), true)
  const cleaned = cleanupDataDirs(source, { currentDir: target })
  assert.equal(cleaned.ok, true)
  assert.equal(fs.existsSync(path.join(source, 'pending')), false)
}
{
  const stranger = tempDir('stranger')
  fs.mkdirSync(path.join(stranger, 'library'), { recursive: true })
  fs.writeFileSync(path.join(stranger, 'library', 'user-file.txt'), 'keep')
  const result = cleanupDataDirs(stranger, { currentDir: tempDir('current') })
  assert.equal(result.ok, false)
  assert.match(result.error, /所有权标记/)
  assert.equal(fs.existsSync(path.join(stranger, 'library', 'user-file.txt')), true)
}

// ------------------------------------------------------------- API handler
async function invoke (handler, { method = 'POST', url = ROUTE, headers = {}, body = '{}', remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from([Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = headers
  req.socket = { remoteAddress }
  let payload = ''
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (value) { payload += value ?? '' }
  }
  await handler(req, res)
  return { status: res.statusCode, body: payload === '' ? null : JSON.parse(payload) }
}
{
  const handler = createHandler({ handle: async (body) => ({ echo: body.op }) }, null)
  const plain = await invoke(handler, {
    headers: { 'content-type': 'text/plain', host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' },
    body: JSON.stringify({ op: 'config.wipeAllData' })
  })
  assert.equal(plain.status, 403, 'text/plain simple request must be rejected')
  const missingOrigin = await invoke(handler, {
    headers: { 'content-type': 'application/json', host: '127.0.0.1:1' }
  })
  assert.equal(missingOrigin.status, 403, 'missing Origin must be rejected')
  const nullOrigin = await invoke(handler, {
    headers: { 'content-type': 'application/json', host: '127.0.0.1:1', origin: 'null' }
  })
  assert.equal(nullOrigin.status, 403, 'null Origin must be rejected')
  const wrongScheme = await invoke(handler, {
    headers: { 'content-type': 'application/json', host: '127.0.0.1:1', origin: 'https://127.0.0.1:1' }
  })
  assert.equal(wrongScheme.status, 403, 'Origin scheme must match the local request scheme')
  const missingType = await invoke(handler, {
    headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' }
  })
  assert.equal(missingType.status, 403, 'missing Content-Type must be rejected')
  const rebinding = await invoke(handler, {
    headers: { 'content-type': 'application/json', host: 'attacker.example', origin: 'http://attacker.example' }
  })
  assert.equal(rebinding.status, 403, 'non-loopback Host must be rejected even when Origin matches')
  const remoteClient = await invoke(handler, {
    headers: { 'content-type': 'application/json', host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' },
    remoteAddress: '192.168.1.20'
  })
  assert.equal(remoteClient.status, 403, 'non-loopback clients must be rejected')
  const foreign = await invoke(handler, {
    headers: {
      'content-type': 'application/json',
      host: '127.0.0.1:1',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site'
    }
  })
  assert.equal(foreign.status, 403, 'cross-site origin must be rejected')
  const prefix = await invoke(handler, { url: `${ROUTE}x`, headers: { 'content-type': 'application/json' } })
  assert.equal(prefix.status, 404, 'only the exact route or one of its subpaths is served')
  const ok = await invoke(handler, {
    headers: { 'content-type': 'application/json; charset=utf-8', host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' },
    body: JSON.stringify({ op: 'state.get' })
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { ok: true, value: { echo: 'state.get' } })
}

// --------------------------------------------------- API name collision guard
{
  const dir = tempDir('api')
  const { store, warnings, settings } = makeStore(dir)
  const engine = {
    describe: () => ({ captured: true, completeActive: false, officialNames: ['harness:identity'], fingerprint: null, sections: [] }),
    sync: () => {},
    syncAll: () => {},
    lastDelta: () => null
  }
  const api = createApi({
    store,
    engine,
    dataDir: dir,
    dataDirSource: 'default',
    warnings,
    settings: () => settings,
    saveSettings: () => settings
  })
  await api.handle({ op: 'state.get', sessionId: 'session-a' })
  // Existing override must block a user-added section with the same name.
  store.saveState('session-a', {
    ...store.state('session-a'),
    enabled: true,
    overrides: { 'custom:collision': 'frag_missing' }
  })
  await assert.rejects(
    () => api.handle({ op: 'extra.save', sessionId: 'session-a', name: 'custom:collision', text: 'x' }),
    /同名覆盖段/
  )
  await assert.rejects(
    () => api.handle({ op: 'extra.save', sessionId: 'session-a', name: 'harness:identity', text: 'x' }),
    /官方段/
  )
}
// ------------------------------------------------- preset textId references
{
  const dir = tempDir('preset-ref')
  const { store, warnings, settings } = makeStore(dir)
  const engine = {
    describe: () => ({ captured: true, completeActive: false, officialNames: [], fingerprint: null, sections: [] }),
    sync: () => {},
    syncAll: () => {},
    lastDelta: () => null
  }
  const api = createApi({
    store,
    engine,
    dataDir: dir,
    dataDirSource: 'default',
    warnings,
    settings: () => settings,
    saveSettings: () => settings
  })
  const created = await api.handle({
    op: 'sectionText.create',
    sessionId: 'session-b',
    key: 'custom:note',
    text: 'note body'
  })
  const id = created.text.entry.id
  store.savePresets({
    version: 3,
    presets: [{
      version: 3,
      id: 'preset_x',
      name: 'with text',
      fragmentIds: [],
      extras: [{ name: 'custom:note', anchor: '__end__', order: 0, textId: id }],
      transientSections: [],
      toolPolicy: { allow: null, deny: [] },
      updatedAt: Date.now()
    }]
  })
  const list = await api.handle({ op: 'library.list', sessionId: 'session-b' })
  const entry = list.fragments.find((fragment) => fragment.id === id)
  assert.deepEqual(entry.usage.presets, ['with text'])
  await api.handle({ op: 'fragment.delete', sessionId: 'session-b', id, cascade: true })
  assert.equal(store.presets().presets[0].extras.length, 0, 'preset text reference must be cleaned')
}

// --------------------------------------------------------------- DSH home
{
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '~/.dsh-test-home'
  try {
    assert.equal(resolveDshHome(), path.join(os.homedir(), '.dsh-test-home'))
    assert.equal(bootstrapDir(), path.join(os.homedir(), '.dsh-test-home', 'plugins', 'dsh-prompt-lab'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

// --------------------------------------------------------------- engine smoke
{
  const dir = tempDir('engine')
  const { store } = makeStore(dir)
  const engine = createEngine({
    store,
    logger: { warn () {} },
    releaseOf: () => '0.2.2-rc.3',
    presetOf: async () => ({ id: null, name: null }),
    isDraftSession: () => false
  })
  assert.equal(typeof engine.syncAll, 'function')
  engine.syncAll()
  engine.shutdown()
}

console.log('release candidate checks passed')
