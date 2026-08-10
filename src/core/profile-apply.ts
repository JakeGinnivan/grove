import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import type { GroveConfig, ResolvedProfile } from './config.js'
import { profileList } from './config.js'
import { readRegistry } from './registry.js'

/** Marker so grove only ever rewrites the block it owns. */
const BEGIN = '# >>> grove managed >>>'
const END = '# <<< grove managed <<<'

export interface PlannedChange {
  file: string
  kind: 'git-include' | 'git-profile' | 'claude-permissions'
  description: string
  /** Full content the file will hold, for diffing/dry-run. */
  contents: string
  changed: boolean
}

export const GLOBAL_GITCONFIG = join(homedir(), '.gitconfig')
export const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json')

/**
 * Build the per-profile gitconfig, which is included conditionally by the
 * global config for paths under the profile directory.
 */
function profileGitconfig(profile: ResolvedProfile): string {
  const lines = [
    BEGIN,
    `# Profile: ${profile.name}`,
  ]
  if (profile.description) lines.push(`# ${profile.description}`)

  // pushurl of a bogus scheme makes git refuse the push with a clear error.
  // This is the standard trick for blocking a host at the config level.
  for (const host of profile.blockPushTo ?? []) {
    lines.push(
      '',
      `[url "grove-push-blocked://${profile.name}/"]`,
      `\tpushInsteadOf = https://${host}/`,
      `\tpushInsteadOf = git@${host}:`,
      `\tpushInsteadOf = ssh://git@${host}/`,
    )
  }
  lines.push(END, '')
  return lines.join('\n')
}

/**
 * The includeIf stanzas the global gitconfig needs, as one managed block.
 * With no profiles the block is emitted empty so a prior one is cleared.
 */
function globalIncludeBlock(profiles: ResolvedProfile[]): string {
  if (profiles.length === 0) return ''
  const lines = [BEGIN, '# Managed by grove. Edit profiles with `grove profile`.']
  for (const profile of profiles) {
    // gitdir requires a trailing slash to match everything beneath the dir.
    lines.push(
      '',
      `[includeIf "gitdir:${profile.dir}/"]`,
      `\tpath = ${profileGitconfigPath(profile)}`,
    )
  }
  lines.push(END, '')
  return lines.join('\n')
}

export function profileGitconfigPath(profile: ResolvedProfile): string {
  return join(profile.dir, '.gitconfig')
}

/**
 * Replace the grove-managed block in a file, preserving everything else.
 * Passing an empty block removes the managed section entirely, which is how
 * deleting the last profile cleans up after itself.
 */
function spliceManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(BEGIN)
  const end = existing.indexOf(END)

  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start)
    const after = existing.slice(end + END.length).replace(/^\n/, '')
    const merged = `${before}${block}${after}`
    // Collapse the blank lines left behind when the block is removed.
    return block === '' ? merged.replace(/\n{3,}/g, '\n\n').trimStart() : merged
  }

  if (block === '') return existing
  const separator = existing && !existing.endsWith('\n') ? '\n' : ''
  return existing ? `${existing}${separator}\n${block}` : block
}

async function readIfExists(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, 'utf8') : ''
}

/**
 * Compute every file change needed to make the profiles real, without
 * writing anything. `apply` performs the writes.
 */
export async function planProfileChanges(
  config: GroveConfig,
  /**
   * Directories that used to host a profile. Their managed git block is
   * cleared so a later profile in the same place cannot silently inherit
   * stale push rules.
   */
  formerProfileDirs: string[] = [],
): Promise<PlannedChange[]> {
  const profiles = profileList(config)
  const changes: PlannedChange[] = []

  // With no profiles left there is still work to do: the managed block from
  // a previous run must be cleared, or a removed profile's includeIf would
  // linger in ~/.gitconfig forever.

  // 1. Per-profile gitconfig files (push blocking).
  for (const profile of profiles) {
    const path = profileGitconfigPath(profile)
    const existing = await readIfExists(path)
    const contents = spliceManagedBlock(existing, profileGitconfig(profile))
    changes.push({
      file: path,
      kind: 'git-profile',
      description: profile.blockPushTo?.length
        ? `Block pushes to ${profile.blockPushTo.join(', ')}`
        : 'Profile git settings',
      contents,
      changed: contents !== existing,
    })
  }

  // 1b. Strip the managed block from directories that are no longer profiles.
  for (const dir of formerProfileDirs) {
    const path = join(dir, '.gitconfig')
    const existing = await readIfExists(path)
    if (!existing.includes(BEGIN)) continue
    const contents = spliceManagedBlock(existing, '')
    changes.push({
      file: path,
      kind: 'git-profile',
      description: 'Remove settings for a profile that no longer exists',
      contents,
      changed: contents !== existing,
    })
  }

  // 2. Global gitconfig includeIf stanzas pointing at those files.
  const globalExisting = await readIfExists(GLOBAL_GITCONFIG)
  const globalContents = spliceManagedBlock(
    globalExisting,
    globalIncludeBlock(profiles),
  )
  changes.push({
    file: GLOBAL_GITCONFIG,
    kind: 'git-include',
    description: `Include profile config for ${profiles.length} profile(s)`,
    contents: globalContents,
    changed: globalContents !== globalExisting,
  })

  // 3. Claude permissions so agents can read across all profile directories.
  const claude = await planClaudePermissions(config)
  if (claude) changes.push(claude)

  return changes
}

/**
 * True when any registered repo sits under the default clone directory but
 * outside every profile. A directory nobody clones into does not need to be
 * readable.
 */
async function defaultDirHoldsRepos(config: GroveConfig): Promise<boolean> {
  const entries = await readRegistry(config.reposFile)
  const profiles = profileList(config)
  return entries.some((entry) => {
    const inDefault =
      entry.path === config.defaultCodeDir ||
      entry.path.startsWith(config.defaultCodeDir + sep)
    if (!inDefault) return false
    return !profiles.some(
      (profile) =>
        entry.path === profile.dir || entry.path.startsWith(profile.dir + sep),
    )
  })
}

interface ClaudeSettings {
  permissions?: {
    additionalDirectories?: string[]
    allow?: string[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

async function planClaudePermissions(
  config: GroveConfig,
): Promise<PlannedChange | undefined> {
  // Grant access to every profile directory, plus the default clone
  // directory when repos actually live there. Directories already covered by
  // a broader entry are dropped so the permission list stays minimal.
  const dirs = profileList(config).map((profile) => profile.dir)
  if (await defaultDirHoldsRepos(config)) dirs.push(config.defaultCodeDir)

  const sorted = [...new Set(dirs)].sort()
  const unique = sorted.filter(
    (dir) => !sorted.some((other) => other !== dir && dir.startsWith(other + sep)),
  )

  const existingRaw = await readIfExists(CLAUDE_SETTINGS)
  let settings: ClaudeSettings = {}
  if (existingRaw.trim()) {
    try {
      settings = JSON.parse(existingRaw) as ClaudeSettings
    } catch {
      // Never clobber a settings file we cannot parse.
      return {
        file: CLAUDE_SETTINGS,
        kind: 'claude-permissions',
        description: 'SKIPPED — settings.json is not valid JSON',
        contents: existingRaw,
        changed: false,
      }
    }
  }

  const permissions = { ...(settings.permissions ?? {}) }
  const additional = new Set(permissions.additionalDirectories ?? [])
  const allow = new Set(permissions.allow ?? [])
  for (const dir of unique) {
    additional.add(dir)
    allow.add(`Read(${dir}/**)`)
  }

  permissions.additionalDirectories = [...additional].sort()
  permissions.allow = [...allow]
  const next: ClaudeSettings = { ...settings, permissions }
  const contents = `${JSON.stringify(next, null, 2)}\n`

  return {
    file: CLAUDE_SETTINGS,
    kind: 'claude-permissions',
    description: `Allow reading ${unique.length} code director${unique.length === 1 ? 'y' : 'ies'}`,
    contents,
    changed: contents !== existingRaw,
  }
}

/** Write the planned changes to disk. */
export async function applyChanges(changes: PlannedChange[]): Promise<string[]> {
  const written: string[] = []
  for (const change of changes) {
    if (!change.changed) continue
    await mkdir(join(change.file, '..'), { recursive: true })
    await writeFile(change.file, change.contents, 'utf8')
    written.push(change.file)
  }
  return written
}
