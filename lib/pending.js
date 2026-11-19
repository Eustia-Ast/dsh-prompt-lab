import fs from 'node:fs'
import path from 'node:path'
import { assertNoSymlinkPath } from './path-guard.js'

function safeId (value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Durable per-session reload marker. This is deliberately outside the session
 * log: it drives the UI lock and the post-resume continuation, but never
 * becomes part of the model-visible history.
 */
export function createPendingStore (dataDir) {
  const root = path.join(dataDir, 'pending')
  const fileOf = (sessionId) => path.join(root, `${safeId(sessionId)}.json`)

  const ensure = () => {
    fs.mkdirSync(root, { recursive: true })
    assertNoSymlinkPath(dataDir, root)
  }

  const read = (sessionId) => {
    try {
      const file = fileOf(sessionId)
      assertNoSymlinkPath(dataDir, file)
      const raw = fs.readFileSync(file, 'utf8')
      const value = JSON.parse(raw)
      return value && typeof value === 'object' ? value : null
    } catch {
      return null
    }
  }

  const write = (sessionId, value) => {
    ensure()
    const target = fileOf(sessionId)
    assertNoSymlinkPath(dataDir, target)
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ ...value, sessionId }, null, 2), 'utf8')
    fs.renameSync(temp, target)
    return value
  }

  const remove = (sessionId) => {
    try {
      const file = fileOf(sessionId)
      assertNoSymlinkPath(dataDir, file)
      fs.unlinkSync(file)
    } catch {
      /* absent is the normal case */
    }
  }

  return { read, write, remove }
}
