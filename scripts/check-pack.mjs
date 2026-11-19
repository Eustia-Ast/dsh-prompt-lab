import { execFileSync, execSync } from 'node:child_process'

// Inside an npm script `npm_execpath` points at npm-cli.js, so spawn Node
// directly. That avoids `npm.cmd` and works on Windows without a shell.
// Direct `node scripts/check-pack.mjs` falls back to the shell-resolved npm.
const npmCli = process.env.npm_execpath
let raw
if (typeof npmCli === 'string' && npmCli.endsWith('.js')) {
  raw = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
} else {
  raw = execSync('npm pack --dry-run --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
}
const report = JSON.parse(raw)
const files = report?.[0]?.files
if (!Array.isArray(files)) throw new Error('npm pack did not return a file list')

const names = new Set(files.map((file) => file.path))
const required = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'icon.svg',
  'assets/icon-180.png',
  'lib/path-guard.js'
]
const missing = required.filter((name) => !names.has(name))
const forbidden = files
  .map((file) => file.path)
  .filter((name) => name.startsWith('test/') || name.startsWith('scripts/') ||
    name.startsWith('.github/') || name === 'RELEASE-CHECKLIST.md' || name === 'SECURITY.md')

if (missing.length || forbidden.length) {
  console.error('npm pack content check failed')
  for (const name of missing) console.error(`- missing: ${name}`)
  for (const name of forbidden) console.error(`- should not ship: ${name}`)
  process.exit(1)
}

console.log(`npm pack content check passed (${files.length} files, ${report[0].size} bytes)`)
