import { expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commitAt, gitIn, runCli, type RunResult, type Sandbox } from './sandbox.js'

/** What `grove new --json` reports. */
export interface NewWorktree {
  path: string
  branch: string
  base: string
  parent: string | null
  port: { slot: number; blockStart: number; duplicate: boolean } | null
  portWarning: string | null
}

/**
 * Create a worktree in the sandbox's repo as test setup. A failure here is
 * never what the test is about, so it fails on the spot with grove's own
 * error rather than surfacing later as a missing path.
 */
export async function newWorktree(
  sandbox: Sandbox,
  title: string,
  ...flags: string[]
): Promise<NewWorktree> {
  const result = await runCli(['new', 'demo', '--title', title, ...flags, '--json'], sandbox)
  expect(result.exitCode, result.stdout || result.stderr).toBe(0)
  return result.json()
}

export interface GroveError {
  code: string
  message: string
  hint?: string
}

/**
 * Assert a command failed with `code`, and return the error for any further
 * checks. grove exits 2 when it needed input it could not ask for, 1 for
 * every other failure.
 */
export function expectError(result: RunResult, code: string): GroveError {
  expect(result.exitCode, result.stdout || result.stderr).toBe(code === 'needs_input' ? 2 : 1)
  const { error } = result.json<{ error: GroveError }>()
  expect(error.code).toBe(code)
  return error
}

/** Add a profile rooted at `<sandbox>/<name>` and return that directory. */
export async function addProfile(
  sandbox: Sandbox,
  name: string,
  ...flags: string[]
): Promise<string> {
  const dir = join(sandbox.root, name)
  const result = await runCli(['profile', 'add', name, dir, ...flags, '--json'], sandbox)
  expect(result.exitCode, result.stdout || result.stderr).toBe(0)
  return dir
}

/**
 * Push a commit to the sandbox's remote from a separate clone, the way a
 * colleague's work arrives. `branch` is created unless it is `main`; `file`
 * adds that file, otherwise the commit is empty; `date` pins the commit date
 * for anything that sorts by it. Returns the pushed commit.
 */
export async function pushCommit(
  sandbox: Sandbox,
  { branch = 'main', file, date }: { branch?: string; file?: string; date?: string } = {},
): Promise<string> {
  const clone = await mkdtemp(join(sandbox.root, 'pusher-'))
  await gitIn(['clone', sandbox.remote, clone], sandbox.root)
  await gitIn(['config', 'user.email', 't@e.com'], clone)
  await gitIn(['config', 'user.name', 'T'], clone)
  if (branch !== 'main') await gitIn(['checkout', '-b', branch], clone)

  const message = `work on ${branch}`
  if (file) {
    await writeFile(join(clone, file), `${file}\n`)
    await gitIn(['add', '.'], clone)
  }
  const commitArgs = ['commit', ...(file ? [] : ['--allow-empty']), '-m', message]
  if (date) await commitAt(commitArgs, clone, date)
  else await gitIn(commitArgs, clone)

  await gitIn(['push', '-u', 'origin', branch], clone)
  return gitIn(['rev-parse', 'HEAD'], clone)
}

/** The sandbox's `~/.claude/settings.json`, parsed. */
export async function readClaudeSettings<T = Record<string, unknown>>(
  sandbox: Sandbox,
): Promise<T> {
  return JSON.parse(await readFile(join(sandbox.root, '.claude', 'settings.json'), 'utf8')) as T
}
