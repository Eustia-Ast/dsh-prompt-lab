/**
 * Client bundle smoke: evaluate `client.js` outside the browser with a fake
 * module loader and React, then apply it to a fake slot context. This catches
 * top-level/factory regressions without needing the Web GUI.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const file = path.join(import.meta.dirname, '..', 'client.js')
const source = fs.readFileSync(file, 'utf8')

let definition = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load (value) {
        definition = value
      }
    }
  },
  console: { warn () {}, log () {}, error () {} },
  setTimeout,
  clearTimeout
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

assert.ok(definition !== null, 'client.js must register a module')
assert.equal(definition.id, 'dsh-prompt-lab')

const React = {
  createElement () { return {} },
  useState (initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect () {},
  useMemo (factory) { return factory() },
  useCallback (factory) { return factory }
}
const module = definition.factory(() => React)
assert.equal(typeof module.apply, 'function')
assert.equal(module.inject.join(','), 'slots')

const registrations = []
const ctx = {
  slots: {
    inject (name, fn) { fn() },
    register (spec, component) { registrations.push({ spec, component }) }
  },
  get () { return undefined },
  inject (names, fn) { fn(ctx) }
}
module.apply(ctx)
assert.ok(registrations.some((entry) => entry.spec.name === 'conversation.input.left'))
assert.ok(registrations.some((entry) => entry.spec.name === 'shell.overlay'))
assert.ok(registrations.every((entry) => typeof entry.component === 'function'))

console.log('client smoke checks passed')
