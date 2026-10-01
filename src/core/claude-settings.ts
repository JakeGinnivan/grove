import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, realpath, writeFile } from 'node:fs/promises'

/**
 * Prose hints for Claude Code's auto mode classifier. Without them it sees
 * `grove cleanup` as an opaque command that deletes directories, and blocks
 * routine cleanups.
 *
 * Each hint is identified by its `prefix`, so a later grove release can reword
 * one and re-running install replaces the old wording instead of adding a
 * second copy.
 */
export const AUTO_MODE_HINTS = [
  {
    section: 'environment',
    prefix: 'Org-specific CLIs: grove',
    text:
      "Org-specific CLIs: grove, the user's git worktree manager. It keeps each task in its own " +
      "git worktree beside the repo's main checkout, creates them with `grove new` and " +
      '`grove checkout`, and removes them with `grove cleanup`. `grove list`, `grove repos`, ' +
      '`grove profile list`, and any grove command run with `--dry-run` are read-only.',
  },
  {
    section: 'allow',
    prefix: 'Grove worktree cleanup:',
    text:
      'Grove worktree cleanup: `grove cleanup` without `--force` is allowed. It refuses to remove ' +
      'a worktree with uncommitted changes or unpushed commits, and moves what it removes to the ' +
      'system trash. `--force` discards that work and is not covered by this rule.',
  },
] as const

export type AutoModeHintsStatus = 'added' | 'updated' | 'present' | 'invalid'

export interface AutoModeHintsResult {
  path: string
  status: AutoModeHintsStatus
  /** Why the file was left alone, when `status` is `invalid`. */
  reason?: string
}

/** Claude Code reads `autoMode` only from user settings, not project settings. */
export function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/**
 * Merge grove's hints into Claude Code's user settings.
 *
 * Writes through a symlink rather than replacing it, since settings are often
 * a link into a dotfiles repo. A list that grove creates starts with
 * `$defaults`: an `autoMode` list without it replaces the built-in rules for
 * that section, which would drop protections like the force-push block. An
 * existing list is only appended to, so a user who removed `$defaults` keeps
 * that choice.
 */
export async function applyAutoModeHints(
  options: { dryRun?: boolean } = {},
): Promise<AutoModeHintsResult> {
  const path = claudeSettingsPath()
  const target = existsSync(path) ? await realpath(path) : path

  let raw = ''
  let settings: Record<string, unknown> = {}
  if (existsSync(target)) {
    raw = await readFile(target, 'utf8')
    try {
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : {}
      if (!isRecord(parsed)) throw new Error('not a JSON object')
      settings = parsed
    } catch (error) {
      return { path, status: 'invalid', reason: `could not parse settings: ${(error as Error).message}` }
    }
  }

  const existing = settings.autoMode
  if (existing !== undefined && !isRecord(existing)) {
    return { path, status: 'invalid', reason: '`autoMode` is not an object' }
  }
  const autoMode: Record<string, unknown> = { ...existing }

  let added = false
  let updated = false
  for (const hint of AUTO_MODE_HINTS) {
    const list = autoMode[hint.section]
    if (list !== undefined && !Array.isArray(list)) {
      return { path, status: 'invalid', reason: `\`autoMode.${hint.section}\` is not an array` }
    }
    const entries: unknown[] = list ? [...(list as unknown[])] : ['$defaults']
    const index = entries.findIndex(
      (entry) => typeof entry === 'string' && entry.startsWith(hint.prefix),
    )
    if (index === -1) {
      entries.push(hint.text)
      added = true
    } else if (entries[index] !== hint.text) {
      entries[index] = hint.text
      updated = true
    }
    autoMode[hint.section] = entries
  }

  if (!added && !updated) return { path, status: 'present' }

  if (!options.dryRun) {
    settings.autoMode = autoMode
    await writeFile(target, `${JSON.stringify(settings, null, detectIndent(raw))}\n`, 'utf8')
  }
  return { path, status: added ? 'added' : 'updated' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep the file's existing indentation so the diff is only grove's lines. */
function detectIndent(raw: string): string | number {
  const match = /^\{\s*\n([ \t]+)\S/.exec(raw)
  return match?.[1] ?? 2
}
