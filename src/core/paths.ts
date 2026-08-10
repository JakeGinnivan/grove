import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Canonicalise a path for comparison.
 *
 * git reports worktree paths as realpaths, so on systems where part of the
 * path is a symlink (macOS `/tmp` → `/private/tmp`, symlinked home
 * directories) a plain `resolve()` comparison against a user-supplied path
 * fails. Falls back to `resolve()` when the path does not exist yet.
 */
export function canonical(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** True when two paths refer to the same location on disk. */
export function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b)
}
