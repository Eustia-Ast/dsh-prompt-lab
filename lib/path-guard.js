import fs from 'node:fs'
import path from 'node:path'

/**
 * A Windows junction is a reparse point that `lstat().isSymbolicLink()` does
 * not report as a link. `realpathSync.native()` resolves both junctions and
 * symlinks, so compare it with the lexical path as a second check. The
 * case-insensitive comparison avoids rejecting a normal path only because the
 * filesystem reports a different letter case.
 * @param {string} candidate
 * @returns {boolean}
 */
function isLinkLike (candidate) {
  const stat = fs.lstatSync(candidate)
  if (stat.isSymbolicLink()) return true
  if (process.platform !== 'win32') return false
  // A junction is a reparse point that lstat does not report as a link, and
  // `readlink` does not resolve it on Windows. Compare the resolved path with
  // "resolved parent + same name": a junction redirects to another name, while
  // an 8.3 short component (RUNNER~1) is only a naming difference.
  const absolute = path.resolve(candidate)
  let real
  let parentReal
  try {
    real = fs.realpathSync.native(absolute)
    parentReal = fs.realpathSync.native(path.dirname(absolute))
  } catch {
    return false
  }
  const expected = path.join(parentReal, path.basename(absolute))
  if (real.toLowerCase() === expected.toLowerCase()) return false
  if (/^[^~]{1,6}~\d+$/.test(path.basename(absolute))) return false
  return true
}

/**
 * Assert that target is inside root and that no existing component from root
 * through target is a symlink or Windows junction. Call after creating missing
 * parent directories as well as before reads/writes. This is defense in depth
 * against an Agent or local process replacing Prompt Lab data directories.
 * @param {string} root
 * @param {string} target
 */
export function assertNoSymlinkPath (root, target) {
  const base = path.resolve(root)
  const absolute = path.resolve(target)
  const relative = path.relative(base, absolute)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('storage path escapes the Prompt Lab data directory')
  }

  let baseStat
  try {
    baseStat = fs.lstatSync(base)
  } catch (error) {
    // A Store may be inspected before ensure() creates its root. There is no
    // existing path component to resolve yet; the later mkdir + assertion does
    // the real check.
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (isLinkLike(base) || !baseStat.isDirectory()) {
    throw new Error('Prompt Lab data directory must be a real directory, not a symlink')
  }

  let cursor = base
  const parts = relative.split(path.sep).filter(Boolean)
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index])
    let stat
    try {
      stat = fs.lstatSync(cursor)
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
    if (isLinkLike(cursor)) {
      throw new Error(`symlinked storage path is not allowed: ${path.relative(base, cursor)}`)
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`storage path component is not a directory: ${path.relative(base, cursor)}`)
    }
  }
}
