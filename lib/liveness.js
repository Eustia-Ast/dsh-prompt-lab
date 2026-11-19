/**
 * Session liveness classification for fragment usage and cascade deletion.
 *
 * A session directory under the plugin data dir is not proof that the DSH
 * session still exists: blank windows can be discarded, sessions can be
 * archived, and an old plugin directory can outlive its session. This module
 * classifies ids as:
 *
 *   live      - present in the in-memory Session store
 *   archived  - in the workspace registry's archive set (recoverable)
 *   saved     - present in durable session persistence
 *   missing   - none of the above
 *   unknown   - persistence could not be read; never treat as missing
 *
 * The caller supplies services rather than contexts so this stays testable and
 * free of Cordis assumptions.
 */

function warn (logger, message) {
  try {
    logger?.warn?.(`prompt-lab: ${message}`)
  } catch {
    /* logging must never break a listing */
  }
}

/**
 * @param {readonly string[]} ids
 * @param {{
 *   sessions?: { get?: (id: string) => unknown },
 *   workspaceRegistry?: { archivedSessionIds?: unknown },
 *   sessionPersistence?: { list?: () => Promise<readonly any[]> },
 *   sessionTitle?: { get?: (session: any) => any },
 *   logger?: any
 * }} services
 * @returns {Promise<Map<string, { id: string, status: 'live'|'archived'|'saved'|'missing'|'unknown', title: string|null }>>}
 */
export async function classifySessions (ids, services = {}) {
  const sessions = services.sessions
  const workspaceRegistry = services.workspaceRegistry
  const sessionPersistence = services.sessionPersistence
  const sessionTitle = services.sessionTitle
  const logger = services.logger

  let archived = new Set()
  try {
    const value = workspaceRegistry?.archivedSessionIds
    if (Array.isArray(value)) archived = new Set(value.map(String))
    else if (value !== undefined && typeof value[Symbol.iterator] === 'function') archived = new Set([...value].map(String))
  } catch (error) {
    warn(logger, `cannot read the archived-session set: ${error?.message ?? error}`)
  }

  let persisted = null
  let persistenceUnknown = false
  try {
    if (typeof sessionPersistence?.list === 'function') {
      const list = await sessionPersistence.list()
      persisted = new Set((list ?? []).map((snapshot) => String(snapshot?.header?.id ?? '')))
    }
  } catch (error) {
    persistenceUnknown = true
    warn(logger, `cannot list persisted sessions: ${error?.message ?? error}`)
  }

  const result = new Map()
  for (const rawId of ids) {
    const id = String(rawId)
    let liveSession
    try {
      liveSession = typeof sessions?.get === 'function' ? sessions.get(id) : undefined
    } catch (error) {
      warn(logger, `cannot look up live session ${id}: ${error?.message ?? error}`)
      liveSession = undefined
    }

    let status
    if (liveSession !== undefined) status = 'live'
    else if (archived.has(id)) status = 'archived'
    else if (persisted !== null) status = persisted.has(id) ? 'saved' : 'missing'
    else if (persistenceUnknown) status = 'unknown'
    else status = 'unknown'

    let title = null
    if (liveSession !== undefined) {
      try {
        title = sessionTitle?.get?.(liveSession)?.title ?? null
      } catch {
        title = null
      }
    }
    result.set(id, { id, status, title })
  }
  return result
}

/** Convenience wrapper for one id. */
export async function classifySession (id, services = {}) {
  const map = await classifySessions([id], services)
  return map.get(String(id)) ?? { id: String(id), status: 'unknown', title: null }
}
