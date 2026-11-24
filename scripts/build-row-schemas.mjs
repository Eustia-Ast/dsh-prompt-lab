#!/usr/bin/env node
/**
 * Build `lib/row-schemas.json` from an installed DeepSeek Harness.
 *
 * The Agent preset editor needs three facts per Loader row: the fields its
 * `Config` accepts, the tools it registers, and a usable default config. All
 * three exist inside the installed packages, so this script reads them once at
 * build time instead of asking the Host at runtime (a plugin cannot `import()`
 * packages that live inside the asar).
 *
 * Usage:
 *   node scripts/build-row-schemas.mjs [--dsh <installation dir>] [--out <file>]
 *                                      [--js-yaml <module dir>]
 *
 * Defaults: the desktop installation path, and `lib/row-schemas.json` beside
 * this package. `!!js` expressions in official preset configs are kept as
 * `{ "__jsExpr": "..." }` markers, exactly as the Loader accepts them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const DSH = option('--dsh', 'F:/DSH/resources/app.asar/dsh')
const OUT = option('--out', path.join(import.meta.dirname, '..', 'lib', 'row-schemas.json'))
const PRESETS = ['standard', 'ptc', 'cordis', 'minimal']

function loadYaml () {
  const candidates = [
    option('--js-yaml', ''),
    path.join(import.meta.dirname, '..', 'node_modules', 'js-yaml'),
    'C:/Users/sky/.dsh/profiles/desktop/node_modules/js-yaml'
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const req = createRequire(path.join(candidate, 'package.json'))
      return req('./index.js')
    } catch { /* try next */ }
  }
  try {
    return createRequire(import.meta.url)('js-yaml')
  } catch {
    console.error('js-yaml not found: pass --js-yaml <package dir>')
    process.exit(1)
  }
}

const yaml = loadYaml()
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value) => ({ __jsExpr: String(value) })
})
const yamlSchema = yaml.DEFAULT_SCHEMA.extend([JsExpr])

/** Minimal read-only view of an Electron asar archive. */
function openAsar (archive) {
  const fd = fs.openSync(archive, 'r')
  const head = Buffer.alloc(8)
  fs.readSync(fd, head, 0, 8, 0)
  const size = head.readUInt32LE(4)
  const buffer = Buffer.alloc(size)
  fs.readSync(fd, buffer, 0, size, 8)
  const text = buffer.toString('utf8')
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  const base = 8 + size
  const lookup = (parts) => {
    let node = json
    for (const part of parts) {
      node = node?.files?.[part]
      if (node === undefined) return undefined
    }
    return node
  }
  return {
    json,
    /** Read one file below the archive root. */
    read (relative) {
      const node = lookup(relative.split('/'))
      if (node === undefined || node.files !== undefined) return undefined
      const out = Buffer.alloc(node.size)
      fs.readSync(fd, out, 0, node.size, base + Number(node.offset))
      return out.toString('utf8')
    },
    /** List `.ts` files directly under one directory inside the archive. */
    list (relative) {
      const node = lookup(relative.split('/'))
      if (node?.files === undefined) return []
      return Object.keys(node.files).filter((name) => name.endsWith('.ts')).map((name) => `${relative}/${name}`)
    }
  }
}

const PACKAGE_ROOT = 'dsh/node_modules/@deepseek-ai'
const archivePath = DSH.endsWith('.asar/dsh') ? DSH.slice(0, DSH.indexOf('.asar/') + 5) : DSH
const asar = openAsar(archivePath)
const dshMeta = JSON.parse(asar.read('dsh/package.json') ?? '{}')

/** `@scope/pkg/subpath` → `dsh-pkg`; subpath rows share their package source. */
function packageDir (specifier) {
  const parts = specifier.split('/')
  const name = parts[0].startsWith('@') ? parts[1] : parts[0]
  return name
}

function sourceFiles (specifier) {
  return asar.list(`${PACKAGE_ROOT}/${packageDir(specifier)}/src`)
}

function readSource (specifier) {
  return sourceFiles(specifier).map((file) => ({ file, text: asar.read(file) ?? '' }))
}

/** Flatten the `insert`/`config.plugins` shape of one preset patch into rows. */
function loadPreset (name) {
  const file = `${PACKAGE_ROOT}/dsh-web-app/presets/${name}.patch.yml`
  const text = asar.read(file)
  if (text === undefined) return { name, rows: [], groups: [] }
  const tree = yaml.load(text, { schema: yamlSchema })
  const rows = []
  const groups = []
  const walk = (list) => {
    for (const node of list ?? []) {
      if (node === null || typeof node !== 'object') continue
      if (Array.isArray(node.insert)) { walk(node.insert); continue }
      if (typeof node.name !== 'string') continue
      const config = node.config
      rows.push({
        name: node.name,
        id: node.id ?? null,
        config: config !== null && typeof config === 'object' && !Array.isArray(config) ? config : null,
        disabled: node.disabled === undefined ? undefined : node.disabled
      })
      if (Array.isArray(config) && node.group === true) {
        groups.push({ id: node.id ?? null, isolate: node.isolate ?? null, rows: config })
        walk(config)
      }
      if (config !== null && typeof config === 'object' && Array.isArray(config.plugins)) {
        walk(config.plugins)
      }
    }
  }
  walk(tree)
  return { name, rows, groups }
}

const presets = PRESETS.map(loadPreset)

/** Union of every row name used by a shipped preset, with per-preset facts. */
const facts = new Map()
for (const preset of presets) {
  for (const row of preset.rows) {
    if (row.name === 'cordis:group') continue
    const record = facts.get(row.name) ?? { presets: new Set(), configs: new Map(), disabled: new Set(), groups: new Set() }
    record.presets.add(preset.name)
    if (row.config !== null) {
      const key = JSON.stringify(row.config)
      if (!record.configs.has(key)) record.configs.set(key, { preset: preset.name, config: row.config })
    }
    if (row.disabled !== undefined) record.disabled.add(JSON.stringify(row.disabled))
    facts.set(row.name, record)
  }
}
// Mark rows that live inside a group (only meaningful inside that group).
for (const preset of presets) {
  for (const group of preset.groups) {
    for (const child of group.rows) {
      const fact = facts.get(child.name)
      if (fact !== undefined) fact.groups.add(group.id ?? 'group')
    }
  }
}

/** Parse one literal default; expressions stay `null` (the panel shows empty). */
function literalDefault (source) {
  const text = source.trim()
  if (text === 'void 0' || text === 'undefined' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  const quoted = text.match(/^(['"])([\s\S]*)\1$/)
  if (quoted !== null) {
    return quoted[2].replace(/\\(['"\\nrt])/g, (_, char) => ({ n: '\n', r: '\r', t: '\t' }[char] ?? char))
  }
  if (/^-?\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?$/i.test(text)) return Number(text.replaceAll('_', ''))
  return null
}

/** Enum choices when the schema spells them out as string literals. */
function enumChoices (source) {
  const match = source.match(/z\.(?:union|enum)\(\s*\[([\s\S]*?)\]\s*(?:as\s+const)?\s*\)/)
  if (match === null) return []
  const parts = match[1].split(',').map((part) => part.trim()).filter((part) => part !== '')
  const values = []
  for (const part of parts) {
    const cleaned = part.replace(/\s+as\s+const$/, '').trim()
    const literal = cleaned.match(/^(['"])([\s\S]*)\1$/)
    if (literal === null) return []
    values.push(literal[2].replace(/\\(['"\\])/g, '$1'))
  }
  return values
}

/** Extract Config fields from every `export const Config` / `static Config` block. */
function extractFields (sources) {
  const fields = []
  const seen = new Set()
  for (const { text } of sources) {
    const at = text.search(/export const Config|static Config|static readonly Config/)
    if (at < 0) continue
    const block = text.slice(at, at + 4000)
    const lines = block.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      // The object literal ends at the first column-0 closing brace.
      if (index > 1 && /^\}\)/.test(line)) break
      const match = line.match(/^\s{2,8}([A-Za-z0-9_]+):\s*(.+)$/)
      if (match === null) continue
      if (seen.has(match[1]) || /^Config$/.test(match[1])) continue
      const [, key, rest] = match
      let type = 'unknown'
      if (/z\.boolean\(/.test(rest)) type = 'boolean'
      else if (/z\.number\(/.test(rest)) type = 'number'
      else if (/z\.string\(/.test(rest)) type = 'string'
      else if (/z\.(enum|literal|union)\(/.test(rest)) type = 'enum'
      const def = rest.match(/\.default\(([^)]*)\)/)
      let desc = ''
      for (let back = index - 1; back >= Math.max(0, index - 12); back -= 1) {
        const previous = lines[back].trim()
        if (previous.startsWith('*/')) continue
        if (previous.startsWith('*')) {
          const cleaned = previous.replace(/^\*\s?/, '').trim()
          if (cleaned !== '' && !cleaned.startsWith('@')) desc = cleaned
        } else if (previous !== '') {
          break
        }
      }
      seen.add(key)
      const options = type === 'enum' ? enumChoices(rest) : []
      fields.push({
        key,
        type,
        ...(options.length > 0 ? { options } : {}),
        required: /\.required\(\)/.test(rest),
        default: def === null ? null : literalDefault(def[1]),
        desc
      })
    }
  }
  return fields
}

/** Fallback: plain TypeScript Config interfaces (no schemastery export). */
function extractInterfaceFields (sources) {
  const fields = []
  const seen = new Set()
  for (const { text } of sources) {
    const pattern = /export interface \w*Config\s*\{([\s\S]*?)\n\}/g
    let block
    while ((block = pattern.exec(text)) !== null) {
      for (const line of block[1].split(String.fromCharCode(10))) {
        const match = line.match(/^\s{2}([A-Za-z0-9_]+)(\??):\s*([A-Za-z0-9_<>| ]+)/)
        if (match === null || seen.has(match[1])) continue
        seen.add(match[1])
        const raw = match[3].trim()
        let type = "unknown"
        if (/boolean/.test(raw)) type = "boolean"
        else if (/number/.test(raw)) type = "number"
        else if (/string/.test(raw)) type = "string"
        fields.push({ key: match[1], type, required: match[2] !== "?", default: null, desc: "" })
      }
    }
  }
  return fields
}

function extractTools (sources) {
  const names = new Set()
  for (const { text } of sources) {
    const pattern = /defineTool\(\{[\s\S]{0,500}?name:\s*['"]([a-z][a-z0-9_]*)['"]/g
    let match
    while ((match = pattern.exec(text)) !== null) names.add(match[1])
  }
  return [...names].sort()
}

const rows = {}
const unresolved = []
for (const [name, fact] of [...facts].sort((left, right) => left[0].localeCompare(right[0]))) {
  const sources = readSource(name)
  let fields = sources.length === 0 ? [] : extractFields(sources)
  if (fields.length === 0 && sources.length > 0) fields = extractInterfaceFields(sources)
  const tools = sources.length === 0 ? [] : extractTools(sources)
  const configs = [...fact.configs.values()]
  // Variants (same package configured twice, e.g. subagent spawn/fork) get no
  // single default; the group template carries each variant instead.
  const preferred = configs.find((entry) => entry.preset === 'standard') ?? configs[0]
  const defaultConfig = preferred === undefined ? null : preferred.config
  rows[name] = {
    presets: [...fact.presets].sort(),
    groups: [...fact.groups].sort(),
    tools,
    fields,
    defaultConfig,
    configVariants: configs.length > 1 ? configs.map((entry) => ({ preset: entry.preset, config: entry.config })) : undefined,
    hasConfig: fields.length > 0,
    unresolved: sources.length === 0
  }
  if (rows[name].unresolved) unresolved.push({ name, reason: 'no src' })
}

const templates = []
for (const preset of presets) {
  for (const group of preset.groups) {
    const id = group.id ?? 'group'
    if (templates.some((entry) => entry.id === id)) continue
    templates.push({
      id,
      preset: preset.name,
      isolate: group.isolate,
      rows: group.rows.map((row) => ({
        id: row.id ?? null,
        name: row.name,
        config: row.config ?? null,
        disabled: row.disabled === undefined ? undefined : row.disabled
      }))
    })
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  dsh: dshMeta.version ?? null,
  source: { installation: DSH, presets: PRESETS },
  rows,
  templates
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

console.log(`dsh ${output.dsh}: ${Object.keys(rows).length} rows, ${templates.length} group templates`)
console.log(`unresolved: ${unresolved.length}${unresolved.length === 0 ? '' : ` (${unresolved.map((entry) => `${entry.name}: ${entry.reason}`).join('; ')})`}`)
const noFields = Object.entries(rows).filter(([, row]) => row.fields.length === 0).map(([name]) => name)
console.log(`with fields: ${Object.values(rows).filter((row) => row.fields.length > 0).length}, with tools: ${Object.values(rows).filter((row) => row.tools.length > 0).length}`)
console.log(`no config fields: ${noFields.length}${noFields.length === 0 ? '' : ` (${noFields.join(', ')})`}`)
console.log(`wrote ${OUT}`)
