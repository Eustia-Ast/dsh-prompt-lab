/**
 * Fail closed before npm publish when repository identity or release assets
 * are still placeholders. This is intentionally stricter than `npm test`:
 * local development can run without knowing the eventual GitHub owner.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
const pkg = readJson('package.json')
const entry = fs.readFileSync(path.join(root, 'release/awesome-entry.yml'), 'utf8')
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
const errors = []

const required = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'icon.svg',
  'assets/icon-180.png'
]
for (const name of required) {
  if (!fs.existsSync(path.join(root, name))) errors.push(`missing required release file: ${name}`)
}

const repository = pkg.repository?.url ?? ''
const homepage = pkg.homepage ?? ''
const bugs = pkg.bugs?.url ?? ''
if (!/^git\+https:\/\/github\.com\/[A-Za-z0-9_.-]+\/dsh-prompt-lab\.git$/.test(repository)) {
  errors.push('package.json repository.url must point to the real GitHub repository')
}
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/dsh-prompt-lab#readme$/.test(homepage)) {
  errors.push('package.json homepage must point to the real GitHub README')
}
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/dsh-prompt-lab\/issues$/.test(bugs)) {
  errors.push('package.json bugs.url must point to the real GitHub issues page')
}
const owner = repository.match(/^git\+https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/dsh-prompt-lab\.git$/)?.[1]
if (owner) {
  const expectedRepo = `https://github.com/${owner}/dsh-prompt-lab`
  if (homepage !== `${expectedRepo}#readme`) errors.push('homepage owner/repository must match repository.url')
  if (bugs !== `${expectedRepo}/issues`) errors.push('bugs.url owner/repository must match repository.url')
  if (!entry.includes(`url: ${expectedRepo}`) || !entry.includes(`name: ${owner}/dsh-prompt-lab`)) {
    errors.push('awesome-entry.yml owner/repository must match package.json')
  }
  if (!entry.includes(`raw.githubusercontent.com/${owner}/dsh-prompt-lab/main/assets/icon-180.png`)) {
    errors.push('awesome-entry.yml icon URL must match the real repository owner')
  }
  if (!readme.includes(`github:${owner}/dsh-prompt-lab`)) {
    errors.push('README GitHub install command must use the repository owner')
  }
}
if (
  /\bOWNER\b|REPLACE-WITH-OWNER|<owner>/i.test(`${repository} ${homepage} ${bugs} ${entry}`) ||
  /github:<owner>\/dsh-prompt-lab/i.test(readme)
) {
  errors.push('GitHub owner placeholders remain; replace them before publishing')
}
if (!entry.includes('category: session')) errors.push('awesome-entry.yml must use the session category')
if (!entry.includes('assets/icon-180.png')) errors.push('awesome-entry.yml must reference assets/icon-180.png')
if (!pkg.dsh?.bundle?.patch || !fs.existsSync(path.join(root, pkg.dsh.bundle.patch.replace(/^\.\//, '')))) {
  errors.push('package.json dsh.bundle.patch must reference an existing patch file')
}
if (!pkg.engines?.dsh) errors.push('package.json engines.dsh compatibility range is required')

if (errors.length > 0) {
  console.error('Release metadata check failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}
console.log('Release metadata check passed')
