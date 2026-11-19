/**
 * Serial test runner. The individual checks are node:test-style scripts that
 * exit non-zero on failure; run them in a fresh process so one suite's global
 * state cannot leak into another.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(import.meta.dirname)
const files = fs.readdirSync(dir)
  .filter((name) => name.endsWith('.mjs') && name !== 'run-all.mjs')
  .sort()

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(dir, file)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' }
  })
  if (result.status !== 0) {
    console.error(`FAIL ${file} (exit ${result.status ?? result.signal})`)
    failed += 1
  }
}
if (failed > 0) {
  console.error(`${failed} test file(s) failed`)
  process.exit(1)
}
console.log(`${files.length} test files passed`)
