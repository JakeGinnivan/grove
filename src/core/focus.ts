import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WtError } from './errors.js'
import { git } from './git.js'
import { info, warn } from './output.js'
import { runShell } from './setup-hooks.js'
import { configValue, readWorktreeConfig, type ConfigSource } from './worktree-config.js'

const STATE_FILE = 'grove-focus.json'
const DEFAULT_DIR = 'focus'

/** Who the focus worktree is checked out for. */
export interface FocusOwner {
  worktree: string
  branch: string | null
}

/**
 * Recorded in the common git dir, which every worktree shares, so any of them
 * can answer "what is focused?". It outlives a release: `owner` goes back to
 * null but `path` keeps marking the focus worktree, so cleanup never offers
 * to remove it.
 */
export interface FocusState {
  path: string
  owner: FocusOwner | null
  commit: string
  updatedAt: string
}

export interface FocusConfig {
  dir: string
  activate: string[]
  release: string[]
  /** Git glob pathspecs for files the running app rewrites, such as a schema dump. */
  regenerated: string[]
  source: ConfigSource | null
}

function invalid(message: string): never {
  throw new WtError(`Invalid focus configuration: ${message}`, { code: 'invalid_focus_config' })
}

function stringList(value: unknown, key: string, items: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '')) {
    invalid(`${key} must be an array of ${items}`)
  }
  return value as string[]
}

export async function readFocusConfig(rootWorktree: string): Promise<FocusConfig> {
  const setting = configValue(await readWorktreeConfig(rootWorktree), 'focus')
  if (!setting) return { dir: DEFAULT_DIR, activate: [], release: [], regenerated: [], source: null }

  const raw = setting.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('focus must be an object')
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (key !== 'dir' && key !== 'activate' && key !== 'release' && key !== 'regenerated') {
      invalid(`focus.${key} is not supported`)
    }
  }
  const dir = value.dir ?? DEFAULT_DIR
  // A single directory beside main/: anything else could land inside another
  // worktree, or outside the repo directory entirely.
  if (typeof dir !== 'string' || !/^[A-Za-z0-9._-]+$/.test(dir) ||
      dir === '.' || dir === '..' || dir === 'main') {
    invalid('focus.dir must be a single directory name other than "main"')
  }
  return {
    dir,
    activate: stringList(value.activate, 'focus.activate', 'commands'),
    release: stringList(value.release, 'focus.release', 'commands'),
    regenerated: stringList(value.regenerated, 'focus.regenerated', 'paths'),
    source: setting.source,
  }
}

/**
 * Whether the focus worktree has changes worth protecting: anything except
 * the files listed in `regenerated`, which the app rewrites as it runs.
 */
export async function hasFocusChanges(focusPath: string, config: FocusConfig): Promise<boolean> {
  const excluded = config.regenerated.map((path) => `:(exclude,glob)${path}`)
  const { stdout } = await git(['status', '--porcelain', '--', '.', ...excluded], { cwd: focusPath })
  return stdout.length > 0
}

/**
 * Put the `regenerated` files back as committed, so a checkout neither
 * refuses to overwrite them nor carries them onto the next commit.
 */
export async function resetRegenerated(focusPath: string, config: FocusConfig): Promise<void> {
  if (config.regenerated.length === 0) return
  const included = config.regenerated.map((path) => `:(glob)${path}`)
  const paths = async (args: string[]) =>
    (await git([...args, '-z', '--', ...included], { cwd: focusPath })).stdout.split('\0').filter(Boolean)
  // Only files HEAD has can be checked out from it; one the app created is removed.
  const tracked = await paths(['diff', '--name-only', '--diff-filter=MDT', 'HEAD'])
  const untracked = await paths(['ls-files', '--others', '--exclude-standard'])
  if (tracked.length > 0) await git(['checkout', 'HEAD', '--', ...tracked], { cwd: focusPath })
  if (untracked.length > 0) await git(['clean', '-fq', '--', ...untracked], { cwd: focusPath })
}

async function statePath(gitDir: string): Promise<string> {
  const { stdout } = await git(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: gitDir },
  )
  return join(stdout, STATE_FILE)
}

export async function readFocusState(gitDir: string): Promise<FocusState | undefined> {
  const path = await statePath(gitDir)
  if (!existsSync(path)) return undefined
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as FocusState
    if (typeof state.path === 'string' && typeof state.commit === 'string') return state
  } catch {
    // Reported below.
  }
  warn(`Could not parse ${path}; treating the repo as having no focus worktree.`)
  return undefined
}

export async function writeFocusState(gitDir: string, state: FocusState): Promise<void> {
  await writeFile(await statePath(gitDir), `${JSON.stringify(state, null, 2)}\n`)
}

export type HookPhase = 'activate' | 'release'

export interface HookContext {
  rootWorktree: string
  focusPath: string
  /** The worktree the hook runs on behalf of: incoming for activate, outgoing for release. */
  owner: FocusOwner | null
  from: string | null
  to: string | null
}

/**
 * Run a phase's hooks in the focus worktree, stopping at the first failure.
 * Unlike worktree setup, a half-run hook here leaves a running environment in
 * an unknown state (a migration rolled back, a server not restarted), so it
 * must not pass quietly.
 *
 * Commands committed to the repo are skipped unless `trustRepo` is set.
 */
export async function runFocusHooks(
  phase: HookPhase,
  config: FocusConfig,
  context: HookContext,
  { trustRepo, enabled }: { trustRepo: boolean; enabled: boolean },
): Promise<number> {
  const commands = config[phase]
  if (commands.length === 0 || !enabled) return 0
  if (config.source === 'repo' && !trustRepo) {
    warn(`Skipping ${commands.length} ${phase} hook(s) committed to the repo; pass --setup to run them.`)
    return 0
  }

  info(`Running ${commands.length} ${phase} hook(s)...`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROOT_WORKTREE_PATH: context.rootWorktree,
    GROVE_FOCUS_PATH: context.focusPath,
    GROVE_FOCUS_WORKTREE: context.owner?.worktree ?? '',
    GROVE_FOCUS_BRANCH: context.owner?.branch ?? '',
    GROVE_FOCUS_FROM: context.from ?? '',
    GROVE_FOCUS_TO: context.to ?? '',
  }
  for (const command of commands) {
    info(`  → ${command}`)
    const code = await runShell(command, context.focusPath, env, { stdoutToStderr: true })
    if (code !== 0) {
      throw new WtError(`${phase} hook failed with exit code ${code}: ${command}`, {
        code: 'focus_hook_failed',
        hint: phase === 'release'
          ? 'The focus worktree was left as it was. Fix the hook, or pass --no-hooks to skip it.'
          : `The focus worktree is checked out; finish preparing it by hand in ${context.focusPath}.`,
      })
    }
  }
  return commands.length
}
