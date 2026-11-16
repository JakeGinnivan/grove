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
  source: ConfigSource | null
}

function invalid(message: string): never {
  throw new WtError(`Invalid focus configuration: ${message}`, { code: 'invalid_focus_config' })
}

function commandList(value: unknown, key: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    invalid(`${key} must be an array of commands`)
  }
  return value as string[]
}

export async function readFocusConfig(rootWorktree: string): Promise<FocusConfig> {
  const setting = configValue(await readWorktreeConfig(rootWorktree), 'focus')
  if (!setting) return { dir: DEFAULT_DIR, activate: [], release: [], source: null }

  const raw = setting.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('focus must be an object')
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (key !== 'dir' && key !== 'activate' && key !== 'release') {
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
    activate: commandList(value.activate, 'focus.activate'),
    release: commandList(value.release, 'focus.release'),
    source: setting.source,
  }
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
