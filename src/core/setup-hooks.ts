import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { warn, info } from './output.js'

/**
 * Cursor-compatible worktree config. A repo may define commands to run after
 * a new worktree is created (install deps, link env files, etc).
 */
interface WorktreeConfig {
  'setup-worktree'?: unknown
}

const CONFIG_CANDIDATES = [
  'worktree.json',
  join('.cursor', 'worktrees.json'),
]

export async function readSetupCommands(repoRoot: string): Promise<string[]> {
  for (const candidate of CONFIG_CANDIDATES) {
    const path = join(repoRoot, candidate)
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as WorktreeConfig
      const commands = parsed['setup-worktree']
      if (Array.isArray(commands)) {
        return commands.filter((c): c is string => typeof c === 'string')
      }
    } catch {
      warn(`Could not parse ${path}; skipping worktree setup commands.`)
    }
    return []
  }
  return []
}

/**
 * Run each setup command inside the new worktree. Failures warn and continue,
 * matching the original behaviour: a broken install step should not leave the
 * user without a worktree.
 */
export async function runSetupCommands(
  repoRoot: string,
  worktreePath: string,
  rootWorktreePath: string,
): Promise<void> {
  const commands = await readSetupCommands(repoRoot)
  if (commands.length === 0) return

  info(`Running ${commands.length} worktree setup command(s)...`)
  for (const command of commands) {
    info(`  → ${command}`)
    const code = await runShell(command, worktreePath, {
      ...process.env,
      ROOT_WORKTREE_PATH: rootWorktreePath,
      WT_WORKTREE_PATH: worktreePath,
    })
    if (code !== 0) {
      warn(`Setup command failed (continuing): ${command}`)
    }
  }
}

function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve) => {
    // Setup commands are arbitrary shell strings authored by the repo, so a
    // shell is required here by design.
    const isWindows = process.platform === 'win32'
    const child = isWindows
      ? spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'inherit', 'inherit'] })
      : spawn('/bin/sh', ['-c', command], {
          cwd,
          env,
          stdio: ['ignore', 'inherit', 'inherit'],
        })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
}
