import { spawn } from 'node:child_process'
import { warn, info } from './output.js'
import { configValue, readWorktreeConfig, type ConfigSource } from './worktree-config.js'

/**
 * Cursor-compatible worktree config. A repo may define commands to run after
 * a new worktree is created (install deps, link env files, etc).
 */
export async function readSetupCommands(
  rootWorktree: string,
): Promise<{ commands: string[]; source: ConfigSource } | undefined> {
  const setting = configValue(await readWorktreeConfig(rootWorktree), 'setup-worktree')
  if (!setting) return undefined
  const commands = Array.isArray(setting.value)
    ? setting.value.filter((c): c is string => typeof c === 'string')
    : []
  return { commands, source: setting.source }
}

/**
 * Run each setup command inside the new worktree. Failures warn and continue,
 * matching the original behaviour: a broken install step should not leave the
 * user without a worktree.
 *
 * Commands from the local config always run: the user wrote them. Commands
 * committed to the repo run only when `trustRepo` is set (`--setup`).
 */
export async function runSetupCommands(
  rootWorktree: string,
  worktreePath: string,
  { trustRepo }: { trustRepo: boolean },
): Promise<void> {
  const setup = await readSetupCommands(rootWorktree)
  if (!setup || setup.commands.length === 0) return
  if (setup.source === 'repo' && !trustRepo) return

  info(`Running ${setup.commands.length} worktree setup command(s)...`)
  for (const command of setup.commands) {
    info(`  → ${command}`)
    const code = await runShell(command, worktreePath, {
      ...process.env,
      ROOT_WORKTREE_PATH: rootWorktree,
      WT_WORKTREE_PATH: worktreePath,
    })
    if (code !== 0) {
      warn(`Setup command failed (continuing): ${command}`)
    }
  }
}

/**
 * Run a repo- or user-authored shell string. A shell is required by design.
 * `stdoutToStderr` keeps a command's output out of stdout, where `--json`
 * output and the shell wrapper's cd sentinel go.
 */
export function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  { stdoutToStderr = false }: { stdoutToStderr?: boolean } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const stdout = stdoutToStderr ? process.stderr : 'inherit'
    const stdio: ['ignore', typeof stdout, 'inherit'] = ['ignore', stdout, 'inherit']
    const isWindows = process.platform === 'win32'
    const child = isWindows
      ? spawn(command, { cwd, env, shell: true, stdio })
      : spawn('/bin/sh', ['-c', command], { cwd, env, stdio })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
}
