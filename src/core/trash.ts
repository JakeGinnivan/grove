import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rename, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

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

/** Whether any trash mechanism is available on this platform. */
export async function canTrash(): Promise<boolean> {
  if (trashDirOverride()) return true
  if (await has('trash')) return true
  if (await has('trash-put')) return true
  if (await has('gio')) return true
  return existsSync(join(homedir(), '.Trash'))
}

/**
 * Move a path to the OS trash. Returns false when no mechanism worked, so
 * callers can decide whether to fall back to a permanent delete.
 */
export async function moveToTrash(path: string): Promise<boolean> {
  if (!existsSync(path)) return true

  const override = trashDirOverride()
  if (override) {
    await mkdir(override, { recursive: true })
    return moveInto(override, path)
  }

  for (const [command, args] of [
    ['trash', [path]],
    ['trash-put', [path]],
    ['gio', ['trash', path]],
  ] as const) {
    if (await has(command)) {
      try {
        await execFileAsync(command, [...args])
        return true
      } catch {
        // Try the next mechanism.
      }
    }
  }

  // macOS fallback: move into ~/.Trash ourselves.
  const trashDir = join(homedir(), '.Trash')
  if (existsSync(trashDir)) return moveInto(trashDir, path)

  return false
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
