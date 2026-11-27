import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from './config.js'

/**
 * What grove last wrote to each installed SKILL.md, keyed by absolute path.
 *
 * Comparing an installed skill with the bundled one says only whether they
 * differ. The recorded hash says why: still what grove wrote means a newer
 * grove has a newer skill, so updating it is safe; anything else means the
 * user edited it, and grove leaves it alone.
 */
export interface SkillState {
  installed: Record<string, { hash: string }>
}

export const SKILL_STATE_PATH = join(CONFIG_DIR, 'skills.json')

export async function loadSkillState(): Promise<SkillState> {
  if (!existsSync(SKILL_STATE_PATH)) return { installed: {} }
  try {
    const parsed = JSON.parse(await readFile(SKILL_STATE_PATH, 'utf8')) as Partial<SkillState>
    return { installed: parsed.installed ?? {} }
  } catch {
    // Losing the record only makes edited skills look outdated; it must not
    // stop grove from running.
    return { installed: {} }
  }
}

export async function saveSkillState(state: SkillState): Promise<void> {
  await mkdir(dirname(SKILL_STATE_PATH), { recursive: true })
  await writeFile(SKILL_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** Line endings are normalised so a CRLF checkout of a template still matches. */
export function hashSkill(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex')
}

export type SkillStatus = 'missing' | 'current' | 'outdated' | 'modified'

/**
 * A skill installed before grove kept records has no hash to compare. It is
 * treated as outdated rather than modified: grove owns these skill names, and
 * asking for --force on the first update after upgrading is the experience
 * this record exists to remove.
 */
export function skillStatus(
  installed: string | undefined,
  bundled: string,
  recordedHash: string | undefined,
): SkillStatus {
  if (installed === undefined) return 'missing'
  const hash = hashSkill(installed)
  if (hash === hashSkill(bundled)) return 'current'
  if (recordedHash === undefined || recordedHash === hash) return 'outdated'
  return 'modified'
}
