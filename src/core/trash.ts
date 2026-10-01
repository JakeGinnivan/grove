import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rename, mkdir, rm, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)

async function has(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    await execFileAsync(probe, [command])
    return true
  } catch {
    return false
  }
}

/**
 * An explicit trash directory. Set GROVE_TRASH_DIR to override the platform
 * default; primarily useful for testing and for Linux setups without a
 * freedesktop trash helper installed.
 */
function trashDirOverride(): string | undefined {
  const dir = process.env['GROVE_TRASH_DIR'] ?? process.env['WT_TRASH_DIR']
  return dir && dir.length > 0 ? dir : undefined
}

/**
 * Folder beside the worktrees that takes removed ones when the system trash
 * will not. Claude Code's sandbox cannot write `~/.Trash`, so every system
 * mechanism fails there, but anything allowed to delete a worktree may rename
 * it within the same parent directory.
 */
export const LOCAL_TRASH = '.grove-trash'

/** Entries in the local trash older than this are deleted for good. */
const LOCAL_TRASH_DAYS = 14

/**
 * Where a removed path went: `system` for the OS trash, otherwise the
 * directory it was moved into.
 */
export type TrashDestination = 'system' | string

/**
 * Move a path out of the way without destroying it: the OS trash where that
 * works, otherwise the local trash beside it. Undefined when nothing worked,
 * so a failed move never silently becomes a permanent delete.
 */
export async function moveToTrash(path: string): Promise<TrashDestination | undefined> {
  if (!existsSync(path)) return 'system'

  // An explicit trash dir is the only place tried: falling back elsewhere
  // would surprise whoever set it.
  const override = trashDirOverride()
  if (override) {
    await mkdir(override, { recursive: true })
    return (await moveInto(override, path)) ? override : undefined
  }

  if (process.env['GROVE_SYSTEM_TRASH'] === '0') return localTrash(path)

  for (const [command, args] of [
    ['trash', [path]],
    ['trash-put', [path]],
    ['gio', ['trash', path]],
  ] as const) {
    if (await has(command)) {
      try {
        await execFileAsync(command, [...args])
        return 'system'
      } catch {
        // Try the next mechanism.
      }
    }
  }

  // macOS fallback: move into ~/.Trash ourselves.
  const trashDir = join(homedir(), '.Trash')
  if (existsSync(trashDir) && (await moveInto(trashDir, path))) return 'system'

  return localTrash(path)
}

async function localTrash(path: string): Promise<string | undefined> {
  const slot = await localTrashSlot(dirname(path))
  return (await moveInto(slot, path)) ? slot : undefined
}

/**
 * A fresh folder in the local trash for one removal. Its age is what
 * `purgeLocalTrash` goes by, since a moved directory keeps its own mtime.
 */
async function localTrashSlot(parent: string): Promise<string> {
  const root = join(parent, LOCAL_TRASH)
  await mkdir(root, { recursive: true })
  // Keeps git from ever seeing it, should the parent be a working tree.
  const ignore = join(root, '.gitignore')
  if (!existsSync(ignore)) await writeFile(ignore, '*\n')
  const slot = join(root, new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(slot, { recursive: true })
  return slot
}

/** Delete local trash entries older than LOCAL_TRASH_DAYS. Returns how many. */
export async function purgeLocalTrash(parent: string, now = Date.now()): Promise<number> {
  const root = join(parent, LOCAL_TRASH)
  if (!existsSync(root)) return 0
  const cutoff = now - LOCAL_TRASH_DAYS * 24 * 60 * 60 * 1000
  let purged = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const slot = join(root, entry.name)
    if ((await stat(slot)).mtimeMs < cutoff) {
      await rm(slot, { recursive: true, force: true })
      purged++
    }
  }
  return purged
}

/** Move `path` into `trashDir`, de-duplicating the destination name. */
async function moveInto(trashDir: string, path: string): Promise<boolean> {
  const name = basename(path)
  let target = join(trashDir, name)
  if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    target = join(trashDir, `${name}-${stamp}`)
  }
  try {
    await rename(path, target)
    return true
  } catch {
    return false
  }
}

/** Permanently delete a directory. */
export async function deletePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}
