/**
 * Render-harness probe for the installed Prompt Lab client component.
 * Extracts `AgentPresetTab` from client.js and renders it with stub hooks so a
 * plain-JS crash surfaces outside the browser.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const target = process.argv[2] ?? fileURLToPath(new URL('../client.js', import.meta.url))
const source = fs.readFileSync(target, 'utf8')

const startMarker = '    // ------------------------------------------------------ agent preset tab'
const endMarker = '    // ----------------------------------------------------------- preset tab'
const start = source.indexOf(startMarker)
const end = source.indexOf(endMarker)
if (start < 0 || end < 0) throw new Error('markers missing')
const componentSource = source.slice(start, end)

const h = (type, props, ...children) => {
  if (type === undefined) throw new Error('h() called with undefined type')
  return { type: typeof type === 'function' ? type.name : type, props: props ?? {}, children }
}
const css = new Proxy({}, { get: (_, key) => ({ __style: String(key) }) })
const PALETTE = new Proxy({}, { get: (_, key) => `palette-${String(key)}` })
const badge = (label) => ({ type: 'badge', label })
const call = async () => ({})
const noop = () => {}

function render (seed, seedDraft = null, overrides = {}) {
  let index = 0
  const useState = (initial) => {
    const value = index === 0 ? seed : index === 1 ? seedDraft : Object.prototype.hasOwnProperty.call(overrides, index) ? overrides[index] : initial
    index += 1
    return [value, noop]
  }
  const useEffect = () => {}
  const useCallback = (fn) => fn
  const factory = new Function(
    'h', 'css', 'PALETTE', 'badge', 'call', 'useState', 'useEffect', 'useCallback', 'setError', 'setToast',
    `${componentSource}\nreturn AgentPresetTab`
  )
  const Component = factory(h, css, PALETTE, badge, call, useState, useEffect, useCallback, noop, noop)
  return Component({ sessionId: 'session-1', setError: noop, setToast: noop })
}

const states = {
  'loading (state null)': null,
  'unsupported': { version: 1, supported: false, limit: 0, reservedIds: [], catalog: [], fragments: [], roster: [], failures: [], presets: [] },
  'empty supported': { version: 1, supported: true, limit: 20, reservedIds: ['standard'], catalog: [{ name: '@deepseek-ai/dsh-tool-fs', label: '文件读写', note: 'x' }], fragments: [{ id: 'f1', label: 'L', preview: 'p' }], roster: [], failures: [], presets: [] },
  'with preset and broken': {
    version: 1,
    supported: true,
    limit: 20,
    reservedIds: ['standard'],
    catalog: [],
    fragments: [],
    roster: [],
    failures: [{ id: 'x', error: 'boom' }],
    presets: [{
      id: 'review',
      name: 'Review',
      description: 'd',
      order: 10,
      enabled: true,
      rows: ['@deepseek-ai/dsh-tool-fs'],
      prompt: { fragmentIds: ['f1'], text: '', prefix: 'abc', suffix: '' },
      runtime: { mounted: false, broken: 'tool-x: boom', registered: false, foreign: false }
    }]
  },
  'malformed state (missing fields)': { version: 1 }
}

let failed = 0
for (const [name, state] of Object.entries(states)) {
  try {
    const tree = render(state)
    console.log(`ok   ${name} -> ${tree?.type}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
    console.log(error.stack.split('\n').slice(0, 4).join('\n'))
  }
}

const groupedState = {
  version: 1,
  supported: true,
  limit: 20,
  reservedIds: ["standard"],
  catalog: [
    { name: "@deepseek-ai/dsh-tool-fs", label: "文件读写", note: "读/写", group: "文件", kind: "row", config: {}, fields: [], tools: ["read", "write"] },
    { name: "@deepseek-ai/dsh-tool-bash", label: "Bash shell", note: "bash", group: "shell", kind: "row", config: {}, fields: [], tools: ["bash"] }
  ],
  templates: [{ id: "compaction", label: "压缩", isolate: { compaction: true }, rows: [{ name: "@deepseek-ai/dsh-compaction-basic" }] }],
  fragments: [],
  roster: [],
  failures: [],
  presets: []
}
const templateDraft = { id: "t", name: "T", description: "", order: 100, enabled: true, rows: ["@deepseek-ai/dsh-tool-bash"], plugins: [], templates: ["compaction"], prompt: { fragmentIds: [], text: "", suffix: "" } }
for (const [label, state, draft] of [["editor: grouped catalog", groupedState, templateDraft]]) {
  try {
    const tree = render(state, draft)
    console.log(`ok   ${label} -> ${tree?.type}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}: ${error.message}`)
  }
}

const readyState = states['empty supported']
const drafts = {
  'editor: new draft': { id: '', name: '', description: '', order: 100, enabled: true, rows: [], plugins: [], prompt: { fragmentIds: [], text: '', suffix: '' } },
  'editor: existing draft': { id: 'review', name: 'Review', description: 'd', order: 10, enabled: true, rows: ['@deepseek-ai/dsh-tool-fs'], plugins: [], prompt: { fragmentIds: ['f1'], text: 'tail', suffix: '' } },
  'editor: copied draft': {
    id: 'standard-copy',
    name: 'Standard 副本',
    description: '复制自 standard',
    order: 2,
    enabled: true,
    rows: [],
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'hi' } },
      { id: 'shell', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } }
    ],
    prompt: { fragmentIds: [], text: '', suffix: '' }
  }
}
for (const [name, draft] of Object.entries(drafts)) {
  try {
    const tree = render(readyState, draft)
    console.log(`ok   ${name} -> ${tree?.type}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
    console.log(error.stack.split('\n').slice(0, 4).join('\n'))
  }
}

// P5: the stale-table banner carries both versions, and only appears when the
// generated table disagrees with the installed DSH.
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}
const withStatus = (schemaStatus) => ({ ...states['empty supported'], schemaStatus })
for (const [label, schemaStatus, expected] of [
  ['stale banner shown', { table: '0.2.1', current: '0.2.2-rc.5', stale: true, generatedAt: 'x' }, '行配置表按 DSH 0.2.1 生成'],
  ['stale banner hidden when current', { table: '0.2.2-rc.5', current: '0.2.2-rc.5', stale: false, generatedAt: 'x' }, null],
  ['stale banner hidden when version unknown', { table: '0.2.1', current: null, stale: false, generatedAt: 'x' }, null]
]) {
  try {
    const text = textOf(render(withStatus(schemaStatus)))
    if (expected === null) {
      if (text.includes('行配置表按 DSH')) throw new Error('unexpected banner')
    } else if (!text.includes(expected)) {
      throw new Error(`banner missing: ${expected}`)
    }
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}: ${error.message}`)
  }
}

// P6 acceptance: a catalog row with fields exposes 配置; a mount-only row does
// not; rows the picker cannot add arrive only through a copy and stay JSON-only.
const fieldState = {
  ...groupedState,
  catalog: [
    {
      name: '@deepseek-ai/dsh-tool-fs',
      label: '文件读写',
      note: '读/写',
      group: '文件',
      kind: 'row',
      config: { write: true },
      fields: [{ key: 'write', type: 'boolean', required: false, default: 'true', desc: '' }],
      tools: ['read'],
      required: []
    },
    {
      name: '@deepseek-ai/dsh-tool-schedule',
      label: '定时任务',
      note: 'schedule_*',
      group: '任务',
      kind: 'row',
      config: {},
      fields: [],
      tools: ['schedule_create'],
      required: []
    }
  ],
  templates: []
}
const countOf = (text, needle) => text.split(needle).length - 1
const buttonLabels = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) buttonLabels(child, out)
    return out
  }
  if (node.type === 'button') {
    out.push(textOf(node.children))
    return out
  }
  buttonLabels(node.children, out)
  return out
}
const selectNodes = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) selectNodes(child, out)
    return out
  }
  if (node.type === 'select') {
    out.push(node)
    return out
  }
  selectNodes(node.children, out)
  return out
}
const badgeLabels = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) badgeLabels(child, out)
    return out
  }
  if (node.type === 'badge') {
    out.push(node.label)
    return out
  }
  badgeLabels(node.children, out)
  return out
}
const checkboxes = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) checkboxes(child, out)
    return out
  }
  if (node.type === 'input' && node.props?.type === 'checkbox') {
    out.push(node)
    return out
  }
  checkboxes(node.children, out)
  return out
}
const runCase = (label, state, draft, overrides, verify) => {
  try {
    const tree = render(state, draft, overrides)
    verify(tree, textOf(tree), buttonLabels(tree))
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}: ${error.message}`)
  }
}
const emptyDraft = { ...templateDraft, rows: [], templates: [] }

runCase('catalog A row exposes 配置', fieldState, { ...templateDraft, rows: ['@deepseek-ai/dsh-tool-fs'], templates: [] }, {}, (tree, text, labels) => {
  if (!labels.includes('配置')) throw new Error('missing 配置 button')
  if (labels.includes('编辑 config')) throw new Error('unexpected raw JSON button')
})
runCase('catalog mount-only row has no 配置', fieldState, { ...templateDraft, rows: ['@deepseek-ai/dsh-tool-schedule'], templates: [] }, {}, (tree, text, labels) => {
  if (labels.includes('配置')) throw new Error('unexpected 配置 button')
})
runCase('copied catalog row shows checked', fieldState,
  { ...emptyDraft, plugins: [{ name: '@deepseek-ai/dsh-tool-fs', config: { write: true } }, { name: '@deepseek-ai/dsh-persona' }] }, {},
  (tree) => {
    const boxes = checkboxes(tree)
    if (boxes.length === 0) throw new Error('no checkboxes rendered')
    const checked = boxes.filter((box) => box.props.checked === true)
    if (checked.length !== 1) throw new Error(`expected 1 checked box, got ${checked.length}`)
  })
runCase('copied A row gets 配置 and extras keep JSON', fieldState,
  { ...emptyDraft, plugins: [{ name: '@deepseek-ai/dsh-tool-fs', config: { write: true } }, { name: '@deepseek-ai/dsh-persona' }] }, {},
  (tree, text, labels) => {
    if (!labels.some((label) => label.startsWith('配置'))) throw new Error('missing 配置 button')
    if (!labels.includes('编辑 config')) throw new Error('extras lost 编辑 config')
    if (!text.includes('其它行')) throw new Error('extras section missing')
  })
runCase('copied A row panel renders fields', fieldState,
  { ...emptyDraft, plugins: [{ name: '@deepseek-ai/dsh-tool-fs', config: { write: true } }] }, { 7: '@deepseek-ai/dsh-tool-fs' },
  (tree, text) => {
    if (!text.includes('write')) throw new Error('field panel missing write')
    if (!text.includes('高级 JSON')) throw new Error('missing 高级 JSON fallback')
  })
runCase('copied extras keep their order', fieldState,
  {
    ...emptyDraft,
    plugins: [
      { name: '@deepseek-ai/dsh-persona' },
      { name: 'cordis:group', group: true, isolate: { planMode: true }, config: [{ name: '@deepseek-ai/dsh-plan-mode', config: { section: 's' } }] },
      { name: '@deepseek-ai/dsh-tool-executor-ptc' }
    ]
  }, {},
  (tree, text, labels) => {
    const order = ['@deepseek-ai/dsh-persona', 'cordis:group', '@deepseek-ai/dsh-tool-executor-ptc'].map((name) => text.indexOf(name))
    if (order.some((at) => at < 0)) throw new Error('extras missing rows')
    if (!(order[0] < order[1] && order[1] < order[2])) throw new Error('extras order changed')
    if (!badgeLabels(tree).includes('分组')) throw new Error('group badge missing')
    if (labels.filter((label) => label === '编辑 config').length < 2) throw new Error('extras JSON buttons missing')
  })

const enumState = {
  ...fieldState,
  catalog: [
    {
      name: '@deepseek-ai/dsh-tool-ask-user',
      label: '提问',
      note: 'ask_user_question',
      group: '交互',
      kind: 'row',
      config: {},
      fields: [{ key: 'mode', type: 'enum', options: ['legacy', 'timed'], required: false, default: 'legacy', desc: '' }],
      tools: ['ask_user_question'],
      required: []
    },
    {
      name: '@deepseek-ai/dsh-tool-fs',
      label: '文件读写',
      note: '读/写',
      group: '文件',
      kind: 'row',
      config: {},
      fields: [{ key: 'maxBytes', type: 'number', required: true, default: null, desc: '' }],
      tools: ['read'],
      required: ['maxBytes']
    }
  ],
  templates: []
}
runCase('enum field renders a dropdown', enumState,
  { ...templateDraft, rows: ['@deepseek-ai/dsh-tool-ask-user'], templates: [] }, { 7: '@deepseek-ai/dsh-tool-ask-user' },
  (tree, text) => {
    if (!selectNodes(tree).length) throw new Error('no select rendered')
    if (!text.includes('legacy') || !text.includes('timed')) throw new Error('options missing')
  })
runCase('null default points at the docs', enumState,
  { ...templateDraft, rows: ['@deepseek-ai/dsh-tool-fs'], templates: [] }, { 7: '@deepseek-ai/dsh-tool-fs' },
  (tree, text) => {
    if (!text.includes('默认值见文档')) throw new Error('missing default hint')
  })
runCase('complete toggle replaces the fragment list', enumState,
  { ...templateDraft, complete: true, rows: ['@deepseek-ai/dsh-tool-fs'], templates: [] }, {},
  (tree, text) => {
    if (!text.includes('完整提示词（整篇替换）')) throw new Error('missing complete heading')
    if (!text.includes('保存时写入 persona 行')) throw new Error('missing complete hint')
    if (text.includes('提示词（来自片段库）')) throw new Error('fragment heading still shown')
  })
runCase('fragment list returns when complete is off', enumState,
  { ...templateDraft, complete: false, rows: ['@deepseek-ai/dsh-tool-fs'], templates: [] }, {},
  (tree, text) => {
    if (!text.includes('提示词（来自片段库）')) throw new Error('fragment heading missing')
    if (text.includes('完整提示词（整篇替换）')) throw new Error('complete heading leaked')
  })

const copyCompleteState = { ...fieldState, limits: { text: 50_000 } }
runCase('copied complete shows the prompt card', copyCompleteState,
  {
    ...emptyDraft,
    plugins: [
      { name: '@deepseek-ai/dsh-persona', config: { prefix: 'Whole prompt', complete: true, includeRuntimeContext: false } },
      { name: '@deepseek-ai/dsh-tool-fs', config: {} }
    ]
  }, {},
  (tree, text) => {
    if (!text.includes('完整提示词（来自 persona 行）')) throw new Error('missing copy complete heading')
    if (!text.includes('persona config（JSON）')) throw new Error('missing persona config editor')
    if (!text.includes('12 / 50000 字')) throw new Error('missing counter')
    if (text.includes('@deepseek-ai/dsh-persona')) throw new Error('persona should leave the extras list')
  })
runCase('copied non-complete hides the prompt card', copyCompleteState,
  { ...emptyDraft, plugins: [{ name: '@deepseek-ai/dsh-persona', config: { prefix: 'x' } }] }, {},
  (tree, text) => {
    if (text.includes('完整提示词（来自 persona 行）')) throw new Error('unexpected prompt card')
    if (!text.includes('@deepseek-ai/dsh-persona')) throw new Error('persona should stay in extras')
  })
runCase('over-limit text warns and disables save', copyCompleteState,
  { ...templateDraft, rows: [], templates: [], prompt: { fragmentIds: [], text: 'x'.repeat(50_001) } }, {},
  (tree, text, labels) => {
    if (!text.includes('超出上限，保存会被拒绝')) throw new Error('missing over-limit warning')
    if (!text.includes('50001 / 50000 字')) throw new Error('missing counter value')
  })

const templateState = {
  ...fieldState,
  templates: [{ id: 'compaction', label: '压缩', isolate: { compaction: true }, rows: [{ name: '@deepseek-ai/dsh-compaction-basic' }] }]
}
runCase('copied preset hides the template section', templateState,
  { ...emptyDraft, plugins: [{ name: '@deepseek-ai/dsh-tool-fs' }] }, {},
  (tree, text) => {
    if (text.includes('组模板（整组插入')) throw new Error('template section shown for a copy')
  })
runCase('self-built preset keeps the template section', templateState,
  { ...templateDraft, rows: ['@deepseek-ai/dsh-tool-fs'], templates: [] }, {},
  (tree, text) => {
    if (!text.includes('组模板（整组插入')) throw new Error('template section missing')
  })

process.exitCode = failed === 0 ? 0 : 1
