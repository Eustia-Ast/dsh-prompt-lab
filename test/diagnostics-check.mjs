import assert from 'node:assert/strict'
import { diagnoseProbeError } from '../lib/diagnostics.js'

function errorAt (frame, message = 'assembly failed') {
  const error = new Error(message)
  error.stack = `${message}\n    at outer (node:internal/process/task_queues:1:1)\n    at ${frame}`
  return error
}

const plugin = diagnoseProbeError(errorAt('isPtc (file:///opt/dsh/profiles/desktop/node_modules/acme-ops/lib/ptc/index.js:20:44)'))
assert.equal(plugin.source, 'plugin')
assert.equal(plugin.package, 'acme-ops')
assert.match(plugin.hint, /第三方插件 acme-ops/)
assert.doesNotMatch(plugin.hint, /0\.5\.5/)

const scoped = diagnoseProbeError(errorAt('x (file:///opt/dsh/profiles/desktop/node_modules/@scope/pkg/lib/main.js:1:2)'))
assert.equal(scoped.source, 'plugin')
assert.equal(scoped.package, '@scope/pkg')

const own = diagnoseProbeError(errorAt('x (file:///opt/dsh-prompt-lab/lib/engine.js:10:2)'))
assert.equal(own.source, 'prompt-lab')
assert.match(own.hint, /Prompt Lab 自身/)

const builtin = diagnoseProbeError(errorAt('x (file:///opt/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:1:1)'))
assert.equal(builtin.source, 'dsh')
assert.match(builtin.hint, /DSH 内置/)

const unknown = diagnoseProbeError(errorAt('x (node:internal/process/task_queues:1:1)'))
assert.equal(unknown.source, 'unknown')
assert.match(unknown.hint, /无法确定/)

const noStack = Object.assign(new Error('no stack'), { stack: undefined })
const missing = diagnoseProbeError(noStack)
assert.equal(missing.source, 'unknown')
assert.equal(missing.frame, null)
assert.match(missing.detail, /no stack/)

console.log('diagnostic checks passed')
