/**
 * Workspace warning file checks.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  WORKSPACE_WARNING_FILE,
  ensureWorkspaceWarning,
  workspaceWarningContent
} from '../lib/workspace-warning.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-workspace-warning-'))
const dataDir = path.join(root, 'data')

const content = workspaceWarningContent({ dataDir, version: 'test' })
assert.match(content, /Prompt Lab 的数据目录/)
assert.match(content, /do not modify anything/)
assert.match(content, /告知用户/)
assert.match(content, /如果这个目录不是当前会话的工作区/)
assert.match(content, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

const created = ensureWorkspaceWarning({ dataDir, version: 'test' })
assert.equal(created.ok, true)
assert.equal(created.created, true)
assert.equal(fs.readFileSync(path.join(dataDir, WORKSPACE_WARNING_FILE), 'utf8'), content)

const unchanged = ensureWorkspaceWarning({ dataDir, version: 'test' })
assert.equal(unchanged.ok, true)
assert.equal(unchanged.unchanged, true)

// A user file with the same name is not overwritten.
const conflictDir = path.join(root, 'conflict')
fs.mkdirSync(conflictDir, { recursive: true })
fs.writeFileSync(path.join(conflictDir, WORKSPACE_WARNING_FILE), 'user file')
const conflict = ensureWorkspaceWarning({ dataDir: conflictDir })
assert.equal(conflict.ok, false)
assert.match(conflict.error, /refusing to overwrite/)
assert.equal(fs.readFileSync(path.join(conflictDir, WORKSPACE_WARNING_FILE), 'utf8'), 'user file')

// Updating a previous auto-generated warning is allowed.
fs.writeFileSync(path.join(dataDir, WORKSPACE_WARNING_FILE), `${content}\nstale`)
const updated = ensureWorkspaceWarning({ dataDir, version: 'test' })
assert.equal(updated.ok, true)
assert.equal(updated.updated, true)
assert.equal(fs.readFileSync(path.join(dataDir, WORKSPACE_WARNING_FILE), 'utf8'), content)

console.log('workspace warning checks passed')
