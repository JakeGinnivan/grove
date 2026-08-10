import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { WtError } from './errors.js'

/**
 * A profile groups repositories that share a location and a policy — for
 * example work code under ~/_code/atlassian with pushes to public hosts
 * blocked, versus open-source dependencies under ~/_code/oss.
 */
export interface Profile {
  /** Base directory that repos for this profile are cloned into. */
  dir: string
  /** Human/agent-facing summary of what belongs here. */
  description?: string
  /** Host fragments whose URLs should be routed to this profile. */
  hosts?: string[]
  /** Refuse to push to remotes matching these host fragments. */
  blockPushTo?: string[]
  /** Free-text policy statements surfaced to agents. */
  rules?: string[]
}

export interface GroveConfig {
  /** Prefix applied to generated branch names, e.g. "jake/". */
  branchPrefix: string
  /** Path to the repo registry file. */
  reposFile: string
  /** Fallback clone directory when no profile matches. */
  defaultCodeDir: string
  /** Named profiles, keyed by profile name. */
  profiles: Record<string, Profile>
  /** Profile used when none is specified and none can be inferred. */
  defaultProfile?: string
  /** Move removed worktrees to the trash instead of deleting them. */
  useTrash: boolean
}

export const CONFIG_DIR = join(homedir(), '.config', 'grove')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

/** Legacy zsh-era registry location, still honoured as the default. */
const LEGACY_REPOS_FILE = join(homedir(), '.wt_repos')

function defaults(): GroveConfig {
  const user = process.env['USER'] ?? process.env['USERNAME'] ?? 'user'
  return {
    branchPrefix: `${user}/`,
    reposFile: LEGACY_REPOS_FILE,
    defaultCodeDir: join(homedir(), '_code'),
    profiles: {},
    useTrash: true,
  }
}

/** Environment overrides, applied on top of the config file. */
function fromEnv(): Partial<GroveConfig> {
  const env: Partial<GroveConfig> = {}
  const prefix = process.env['GROVE_BRANCH_PREFIX'] ?? process.env['WT_BRANCH_PREFIX']
  const reposFile = process.env['GROVE_REPOS_FILE'] ?? process.env['WT_REPOS_FILE']
  const codeDir =
    process.env['GROVE_DEFAULT_CODE_DIR'] ?? process.env['WT_DEFAULT_CODE_DIR']
  if (prefix !== undefined) env.branchPrefix = prefix
  if (reposFile !== undefined) env.reposFile = reposFile
  if (codeDir !== undefined) env.defaultCodeDir = codeDir
  return env
}

/** Expand a leading ~ so config files can use it. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) {
    return join(homedir(), path.slice(2))
  }
  return path
}

export async function loadConfig(): Promise<GroveConfig> {
  let fileConfig: Partial<GroveConfig> = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(
        await readFile(CONFIG_PATH, 'utf8'),
      ) as Partial<GroveConfig>
    } catch {
      // A malformed config should not brick the CLI; fall back to defaults.
      fileConfig = {}
    }
  }

  const base = defaults()
  const env = fromEnv()
  const merged: GroveConfig = {
    ...base,
    ...fileConfig,
    ...env,
    profiles: { ...base.profiles, ...fileConfig.profiles },
  }

  // Normalise paths once so every caller can compare them directly.
  merged.defaultCodeDir = resolve(expandHome(merged.defaultCodeDir))
  merged.reposFile = resolve(expandHome(merged.reposFile))
  merged.profiles = Object.fromEntries(
    Object.entries(merged.profiles).map(([name, profile]) => [
      name,
      { ...profile, dir: resolve(expandHome(profile.dir)) },
    ]),
  )
  return merged
}

export async function saveConfig(config: GroveConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export interface ResolvedProfile extends Profile {
  name: string
}

export function profileList(config: GroveConfig): ResolvedProfile[] {
  return Object.entries(config.profiles)
    .map(([name, profile]) => ({ ...profile, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function getProfile(
  config: GroveConfig,
  name: string,
): ResolvedProfile {
  const profile = config.profiles[name]
  if (!profile) {
    const available = Object.keys(config.profiles)
    throw new WtError(`Unknown profile: ${name}`, {
      code: 'unknown_profile',
      hint: available.length
        ? `Available profiles: ${available.join(', ')}`
        : 'No profiles configured. Add one with `grove profile add <name> <dir>`.',
    })
  }
  return { ...profile, name }
}

/**
 * Find the profile a clone URL belongs to by matching its configured host
 * fragments. Returns undefined when nothing matches.
 */
export function profileForUrl(
  config: GroveConfig,
  url: string,
): ResolvedProfile | undefined {
  for (const profile of profileList(config)) {
    if (profile.hosts?.some((host) => host && url.includes(host))) {
      return profile
    }
  }
  return undefined
}

/** Find the profile that contains a path on disk, if any. */
export function profileForPath(
  config: GroveConfig,
  path: string,
): ResolvedProfile | undefined {
  const target = resolve(path)
  // Prefer the most specific (longest) matching directory, so nested
  // profile directories resolve to the inner one.
  return profileList(config)
    .filter((profile) => target === profile.dir || target.startsWith(profile.dir + sep))
    .sort((a, b) => b.dir.length - a.dir.length)[0]
}

/** The clone directory for a profile, or the global default. */
export function codeDirFor(
  config: GroveConfig,
  profile: ResolvedProfile | undefined,
): string {
  return profile ? profile.dir : config.defaultCodeDir
}

/**
 * Check a clone URL against a profile's push restrictions. Used to stop a
 * repo landing in a directory whose policy forbids its host.
 */
export function profileBlocksUrl(
  profile: ResolvedProfile,
  url: string,
): string | undefined {
  const blocked = profile.blockPushTo?.find((host) => host && url.includes(host))
  return blocked
}
