/**
 * Data-directory migration helpers.
 *
 * A dataDir change is deliberately deferred to the next DSH start: the running
 * Store still uses the old directory, so copying at save time would leave the
 * new copy stale. The startup migration copies only Prompt Lab's own data
 * directories and never touches `config.json` in the bootstrap directory.
 */
import fs from 'node:fs'
import path from 'node:path'
import { OWNER_MARKER_FILE, WORKSPACE_WARNING_FILE, isOwnedDataDir } from './workspace-warning.js'

/** `pending` holds per-session reload locks, but it is Prompt Lab data and must move/clean with the rest. */
export const DATA_SUBDIRS = ['library', 'sessions', 'drafts', 'pending']

function inside (parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function canonicalCandidate (candidate) {
  const absolute = path.resolve(candidate)
  let cursor = absolute
  const suffix = []
  while (true) {
    try {
      const real = fs.realpathSync.native(cursor)
      return path.join(real, ...suffix.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      suffix.push(path.basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Validate a source/target pair without touching the filesystem.
 * @param {string} from
 * @param {string} to
 * @param {{ bootstrapDir?: string }} [options]
 * @returns {string | null} an error message, or null when the pair is usable
 */
export function migrationPathError (from, to, options = {}) {
  if (typeof from !== 'string' || from.trim() === '') return '旧数据目录无效'
  if (typeof to !== 'string' || to.trim() === '') return '新数据目录无效'
  let source
  let target
  try {
    source = canonicalCandidate(from)
    target = canonicalCandidate(to)
  } catch (error) {
    return `无法解析迁移目录：${error?.message ?? error}`
  }
  if (source === target) return '新旧数据目录相同'
  if (inside(source, target) || inside(target, source)) {
    return '新旧数据目录不能互相包含'
  }
  if (target === path.parse(target).root) return '不能使用磁盘根目录作为数据目录'
  if (typeof options.bootstrapDir === 'string' && options.bootstrapDir !== '') {
    let bootstrap
    try {
      bootstrap = canonicalCandidate(options.bootstrapDir)
    } catch (error) {
      return `无法解析插件配置目录：${error?.message ?? error}`
    }
    if (target !== bootstrap && (inside(target, bootstrap) || inside(bootstrap, target))) {
      return '新数据目录不能包含插件配置目录，也不能放在配置目录内部'
    }
  }
  return null
}

/**
 * Whether a directory already contains anything other than the bootstrap
 * `config.json` and temporary files. Used when scheduling a migration: an
 * existing data directory is not silently merged.
 * @param {string} dir
 * @param {{ bootstrapDir?: string }} [options]
 */
export function targetHasContents (dir, options = {}) {
  const target = path.resolve(dir)
  const bootstrap = typeof options.bootstrapDir === 'string' && options.bootstrapDir !== ''
    ? path.resolve(options.bootstrapDir)
    : null
  let entries
  try {
    entries = fs.readdirSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  return entries.some((name) => {
    if (name.endsWith('.tmp')) return false
    if (name === WORKSPACE_WARNING_FILE || name === OWNER_MARKER_FILE) return false
    if (name === 'config.json' && bootstrap !== null && target === bootstrap) return false
    return true
  })
}

/**
 * A pending migration may already have copied some data subdirectories. Any
 * other entry means the user put unrelated files in the target after the path
 * was scheduled; refusing is safer than merging over them.
 * @param {string} dir
 * @param {{ bootstrapDir?: string }} [options]
 */
export function targetHasUnexpectedContents (dir, options = {}) {
  const target = path.resolve(dir)
  const bootstrap = typeof options.bootstrapDir === 'string' && options.bootstrapDir !== ''
    ? path.resolve(options.bootstrapDir)
    : null
  let entries
  try {
    entries = fs.readdirSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  return entries.some((name) => {
    if (name.endsWith('.tmp')) return false
    if (name === WORKSPACE_WARNING_FILE || name === OWNER_MARKER_FILE) return false
    if (name === 'config.json' && bootstrap !== null && target === bootstrap) return false
    if (DATA_SUBDIRS.includes(name)) return false
    return true
  })
}

/**
 * Whether a directory contains meaningful Prompt Lab user data. A session
 * state with only `lastCapture` (the auto-sample written when a panel opens)
 * does not count: this lets a pre-migration dataDir change still be recovered
 * without merging over real configuration.
 * @param {string} dir
 */
export function hasMeaningfulData (dir) {
  try {
    if (fs.readdirSync(path.join(dir, 'library')).length > 0) return true
  } catch (error) {
    if (error?.code !== 'ENOENT') return true
  }
  try {
    if (fs.readdirSync(path.join(dir, 'drafts')).length > 0) return true
  } catch (error) {
    if (error?.code !== 'ENOENT') return true
  }
  let sessions = []
  try {
    sessions = fs.readdirSync(path.join(dir, 'sessions'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
  } catch (error) {
    if (error?.code !== 'ENOENT') return true
  }
  for (const session of sessions) {
    const sessionDir = path.join(dir, 'sessions', session.name)
    try {
      if (fs.readdirSync(path.join(sessionDir, 'backups')).length > 0) return true
    } catch (error) {
      if (error?.code !== 'ENOENT') return true
    }
    let state
    try {
      state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') return true
      continue
    }
    if (!state || typeof state !== 'object') return true
    if (state.enabled === true) return true
    if (Array.isArray(state.extras) && state.extras.length > 0) return true
    if (state.overrides && typeof state.overrides === 'object' &&
        !Array.isArray(state.overrides) && Object.keys(state.overrides).length > 0) return true
    if (state.lastPreset) return true
    if (state.presetModified === true) return true
  }
  return false
}

/**
 * Whether a directory contains Prompt Lab data (as opposed to just empty
 * placeholder directories or a bootstrap config.json). Used by the one-time
 * legacy recovery after upgrading from a version that changed dataDir without
 * scheduling a migration.
 * @param {string} dir
 */
export function hasOwnedData (dir) {
  for (const name of DATA_SUBDIRS) {
    try {
      if (fs.readdirSync(path.join(dir, name)).length > 0) return true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return false
}

function walkFiles (dir) {
  const result = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return result
    throw error
  }
  for (const entry of entries) {
    if (entry.name.endsWith('.tmp')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...walkFiles(full).map((item) => ({ ...item, rel: path.join(entry.name, item.rel) })))
    } else if (entry.isFile()) {
      result.push({ rel: entry.name, size: fs.statSync(full).size })
    }
  }
  return result
}

/**
 * Copy the known data subdirectories. `config.json`, temporary files and any
 * unrelated files in the source directory are left alone. Every copied file is
 * checked for existence and size in the target.
 * @param {string} from
 * @param {string} to
 * @returns {{ ok: true, copied: string[], files: number, bytes: number } | { ok: false, error: string }}
 */
export function copyDataDirs (from, to) {
  let source
  let target
  try {
    source = canonicalCandidate(from)
    target = canonicalCandidate(to)
  } catch (error) {
    return { ok: false, error: `无法解析迁移目录：${error?.message ?? error}` }
  }
  fs.mkdirSync(target, { recursive: true })
  const copied = []
  let files = 0
  let bytes = 0
  try {
    for (const name of DATA_SUBDIRS) {
      const src = path.join(source, name)
      let exists = false
      try {
        exists = fs.statSync(src).isDirectory()
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (!exists) continue
      fs.cpSync(src, path.join(target, name), {
        recursive: true,
        force: true,
        errorOnExist: false,
        filter: (candidate) => !candidate.endsWith('.tmp')
      })
      copied.push(name)
      const items = walkFiles(src)
      for (const item of items) {
        const destination = path.join(target, name, item.rel)
        let stat
        try {
          stat = fs.statSync(destination)
        } catch {
          throw new Error(`迁移校验失败：缺少 ${path.join(name, item.rel)}`)
        }
        if (stat.size !== item.size) {
          throw new Error(`迁移校验失败：${path.join(name, item.rel)} 大小不一致`)
        }
        files += 1
        bytes += item.size
      }
    }
    for (const name of [WORKSPACE_WARNING_FILE, OWNER_MARKER_FILE]) {
      const markerSource = path.join(source, name)
      try {
        const markerStat = fs.statSync(markerSource)
        if (!markerStat.isFile()) continue
        const markerTarget = path.join(target, name)
        fs.cpSync(markerSource, markerTarget, { force: true })
        const copiedStat = fs.statSync(markerTarget)
        if (copiedStat.size !== markerStat.size) {
          throw new Error(`迁移校验失败：${name} 大小不一致`)
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return { ok: true, copied, files, bytes }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * Delete only Prompt Lab's known data subdirectories from an old directory.
 * The directory itself and `config.json` are preserved; the generated warning
 * file is removed together with the data.
 * @param {string} dir
 * @param {{ currentDir?: string, bootstrapDir?: string }} [options]
 * @returns {{ ok: true, removed: string[], warningRemoved: boolean } | { ok: false, error: string }}
 */
export function cleanupDataDirs (dir, options = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, error: '旧数据目录无效' }
  let previous
  try {
    // Resolve junctions/symlinks before the containment checks, otherwise a
    // link named like a safe path can point at the current data directory.
    previous = canonicalCandidate(dir)
  } catch (error) {
    return { ok: false, error: `无法解析旧数据目录：${error?.message ?? error}` }
  }
  if (previous === path.parse(previous).root) return { ok: false, error: '不能清理磁盘根目录' }
  let currentDir = null
  if (typeof options.currentDir === 'string' && options.currentDir !== '') {
    try {
      currentDir = canonicalCandidate(options.currentDir)
    } catch (error) {
      return { ok: false, error: `无法解析当前数据目录：${error?.message ?? error}` }
    }
  }
  if (currentDir !== null && currentDir === previous) {
    return { ok: false, error: '不能清理当前正在使用的数据目录' }
  }
  if (currentDir !== null && (inside(previous, currentDir) || inside(currentDir, previous))) {
    return { ok: false, error: '旧数据目录与当前数据目录存在包含关系，拒绝清理' }
  }
  if (typeof options.bootstrapDir === 'string' && options.bootstrapDir !== '') {
    let bootstrap
    try {
      bootstrap = canonicalCandidate(options.bootstrapDir)
    } catch (error) {
      return { ok: false, error: `无法解析插件配置目录：${error?.message ?? error}` }
    }
    if (previous !== bootstrap && (inside(previous, bootstrap) || inside(bootstrap, previous))) {
      return { ok: false, error: '旧数据目录包含插件配置目录或位于其内部，拒绝清理' }
    }
  }
  // `previousDataDir` comes from config.json, which is user-editable. Never
  // delete the generic `library/`, `sessions/`, `drafts/` names from a
  // directory Prompt Lab did not initialize.
  if (!isOwnedDataDir(previous)) {
    return { ok: false, error: '旧数据目录没有 Prompt Lab 所有权标记，拒绝清理' }
  }
  const removed = []
  try {
    for (const name of DATA_SUBDIRS) {
      const target = path.join(previous, name)
      let exists = false
      try {
        exists = fs.statSync(target).isDirectory()
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (!exists) continue
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(name)
    }
    let warningRemoved = false
    for (const name of [WORKSPACE_WARNING_FILE, OWNER_MARKER_FILE]) {
      const file = path.join(previous, name)
      try {
        if (fs.statSync(file).isFile()) {
          fs.rmSync(file, { force: true })
          if (name === WORKSPACE_WARNING_FILE) warningRemoved = true
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return { ok: true, removed, warningRemoved }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * Run a pending migration recorded in the bootstrap config.
 * The caller must pass `writeConfig` so a successful migration can clear the
 * marker and record `previousDataDir`.
 * @param {Record<string, any>} settings
 * @param {{ bootstrapDir?: string, writeConfig?: (settings: Record<string, any>) => void }} [options]
 */
export function migratePending (settings, options = {}) {
  const pending = settings?.pendingMigration
  if (pending === undefined || pending === null) return { skipped: true }
  if (typeof pending.from !== 'string' || typeof pending.to !== 'string') {
    return { ok: false, error: '待迁移记录无效', from: null, to: null }
  }
  if (settings.dataDir !== pending.to) {
    return { ok: false, error: '待迁移记录与当前 dataDir 不一致', from: pending.from, to: pending.to }
  }
  let source = pending.from
  if (typeof options.bootstrapDir === 'string' && options.bootstrapDir !== '' &&
      path.resolve(options.bootstrapDir) !== path.resolve(source)) {
    try {
      if (!hasMeaningfulData(source) && hasMeaningfulData(options.bootstrapDir)) {
        source = options.bootstrapDir
      }
    } catch {
      /* keep the recorded source if inspection fails */
    }
  }
  const pathError = migrationPathError(source, pending.to, { bootstrapDir: options.bootstrapDir })
  if (pathError !== null) return { ok: false, error: pathError, from: source, to: pending.to }
  if (targetHasUnexpectedContents(pending.to, { bootstrapDir: options.bootstrapDir })) {
    return { ok: false, error: '新数据目录出现其他文件，拒绝迁移', from: source, to: pending.to }
  }
  let sourceExists = false
  try {
    sourceExists = fs.statSync(source).isDirectory()
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ok: false, error: String(error?.message ?? error), from: source, to: pending.to }
    }
  }
  if (!sourceExists) {
    delete settings.pendingMigration
    if (typeof options.writeConfig === 'function') {
      try {
        options.writeConfig(settings)
      } catch (error) {
        return {
          ok: true,
          from: source,
          to: pending.to,
          copied: [],
          files: 0,
          bytes: 0,
          sourceMissing: true,
          warning: `旧目录不存在，但迁移标记未能写入：${error?.message ?? error}`
        }
      }
    }
    return { ok: true, from: source, to: pending.to, copied: [], files: 0, bytes: 0, sourceMissing: true }
  }
  const result = copyDataDirs(source, pending.to)
  if (result.ok !== true) return { ok: false, error: result.error, from: source, to: pending.to }
  settings.previousDataDir = source
  delete settings.pendingMigration
  if (typeof options.writeConfig === 'function') {
    try {
      options.writeConfig(settings)
    } catch (error) {
      return {
        ok: true,
        from: source,
        to: pending.to,
        ...result,
        warning: `数据已复制，但迁移标记未能写入：${error?.message ?? error}`
      }
    }
  }
  return { ok: true, from: source, to: pending.to, ...result }
}
