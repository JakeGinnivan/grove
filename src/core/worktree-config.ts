import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { warn } from './output.js'

/**
 * Where a `worktree.json` setting came from. `repo` is committed to the
 * repository, so its commands are repository-controlled code; `local` sits in
 * the directory holding `main/` and the worktrees, which only this machine's
 * user writes.
 */
export type ConfigSource = 'repo' | 'local'

export interface ConfigValue {
  value: unknown
  source: ConfigSource
  path: string
}

interface ConfigFile {
  path: string
  data: Record<string, unknown>
}

export interface WorktreeConfig {
  repo: ConfigFile | undefined
  local: ConfigFile | undefined
}

const REPO_CANDIDATES = ['worktree.json', join('.cursor', 'worktrees.json')]

/**
 * The local config lives beside `main/`, so it only exists in grove's
 * `<repo>/main` layout. A plain clone's parent directory belongs to whatever
 * else is in it, not to this repo.
 */
export function localConfigPath(rootWorktree: string): string | undefined {
  return basename(rootWorktree) === 'main'
    ? join(dirname(rootWorktree), 'worktree.json')
    : undefined
}

async function readConfigFile(path: string): Promise<ConfigFile | undefined> {
  if (!existsSync(path)) return undefined
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return { path, data: data as Record<string, unknown> }
    }
  } catch {
    // Reported below, the same as a file that parses to a non-object.
  }
  warn(`Could not parse ${path}; ignoring it.`)
  return undefined
}

export async function readWorktreeConfig(rootWorktree: string): Promise<WorktreeConfig> {
  let repo: ConfigFile | undefined
  for (const candidate of REPO_CANDIDATES) {
    const path = join(rootWorktree, candidate)
    if (!existsSync(path)) continue
    repo = await readConfigFile(path)
    break
  }
  const localPath = localConfigPath(rootWorktree)
  const local = localPath ? await readConfigFile(localPath) : undefined
  return { repo, local }
}

/**
 * One top-level setting. The local file wins key by key, so it can add or
 * replace a single setting without restating the rest of the committed file.
 */
export function configValue(config: WorktreeConfig, key: string): ConfigValue | undefined {
  if (config.local && config.local.data[key] !== undefined) {
    return { value: config.local.data[key], source: 'local', path: config.local.path }
  }
  if (config.repo && config.repo.data[key] !== undefined) {
    return { value: config.repo.data[key], source: 'repo', path: config.repo.path }
  }
  return undefined
}
