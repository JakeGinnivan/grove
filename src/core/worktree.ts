import { join, basename } from 'node:path'
import { existsSync } from 'node:fs'
import { WtError } from './errors.js'
import { canonical } from './paths.js'
import {
  git,
  defaultBase,
  listWorktrees,
  localBranchExists,
  remoteBranchExists,
  setConfig,
  getConfig,
  type Worktree,
} from './git.js'
import { runSetupCommands } from './setup-hooks.js'
import { info } from './output.js'

/** git config key recording which branch a stacked worktree was built on. */
export const PARENT_CONFIG_KEY = (branch: string) =>
  `branch.${branch}.wt-parent`

export interface CreateWorktreeOptions {
  /** Parent directory containing the worktrees (and `main/`). */
  repoPath: string
  gitDir: string
  /** Directory name to create under repoPath. */
  worktreeDir: string
  /** Branch to create, or to check out when `useExistingBranch` is set. */
  branch: string
  /**
   * Explicit base ref. When omitted the repo's default remote branch is used.
   * For stacked worktrees this is the parent branch.
   */
  base?: string | undefined
  /** Record this branch as the stack parent for future restacking. */
  parentBranch?: string | undefined
  /** Check out an existing branch rather than creating a new one. */
  useExistingBranch?: boolean
  /** Track the remote branch of the same name (used by `checkout`). */
  track?: string | undefined
  /** Skip `git fetch` before creating. */
  noFetch?: boolean
  /** Skip repo-defined setup commands. */
  noSetup?: boolean
}

export interface CreatedWorktree {
  path: string
  branch: string
  base: string
  parent: string | undefined
}

/**
 * Resolve the base ref for a new worktree.
 *
 * - `--on <worktree|branch>` stacks on top of an existing branch
 * - `--base <ref>` uses an explicit ref
 * - otherwise the repo default (origin/main) is used
 */
export async function resolveBase(
  gitDir: string,
  options: { base?: string | undefined; on?: string | undefined; repoPath: string },
): Promise<{ base: string; parent: string | undefined }> {
  if (options.on) {
    const parent = await resolveStackParent(gitDir, options.repoPath, options.on)
    return { base: parent, parent }
  }
  if (options.base) {
    return { base: options.base, parent: undefined }
  }
  return { base: await defaultBase(gitDir), parent: undefined }
}

/**
 * Turn `--on <value>` into a branch name. Accepts a branch name, a worktree
 * directory name, or a worktree path.
 */
export async function resolveStackParent(
  gitDir: string,
  repoPath: string,
  on: string,
): Promise<string> {
  if (await localBranchExists(gitDir, on)) return on

  const worktrees = await listWorktrees(gitDir)
  const candidatePaths = [canonical(on), canonical(join(repoPath, on))]
  const match = worktrees.find(
    (wt) => candidatePaths.includes(canonical(wt.path)) || basename(wt.path) === on,
  )
  if (match?.branch) return match.branch

  throw new WtError(`Could not resolve --on "${on}" to a branch or worktree.`, {
    code: 'unknown_stack_parent',
    hint: 'Pass a local branch name, a worktree directory name, or a worktree path.',
  })
}

export async function createWorktree(
  options: CreateWorktreeOptions,
): Promise<CreatedWorktree> {
  const {
    repoPath,
    gitDir,
    worktreeDir,
    branch,
    parentBranch,
    useExistingBranch = false,
    track,
    noFetch = false,
    noSetup = false,
  } = options

  const fullPath = join(repoPath, worktreeDir)
  if (existsSync(fullPath)) {
    throw new WtError(`Worktree path already exists: ${fullPath}`, {
      code: 'worktree_exists',
    })
  }

  if (!noFetch) {
    info('Fetching origin...')
    const fetch = await git(['fetch', 'origin', '--prune'], {
      cwd: gitDir,
      allowFailure: true,
    })
    if (fetch.exitCode !== 0) {
      info('Fetch failed; continuing with local refs.')
    }
  }

  const base = options.base ?? (await defaultBase(gitDir))

  const existingWorktrees = await listWorktrees(gitDir)
  const branchInUse = existingWorktrees.find((wt) => wt.branch === branch)
  if (branchInUse) {
    throw new WtError(
      `Branch "${branch}" is already checked out at ${branchInUse.path}`,
      { code: 'branch_in_use' },
    )
  }

  const args = ['worktree', 'add']
  if (useExistingBranch) {
    args.push(fullPath, branch)
  } else {
    if (await localBranchExists(gitDir, branch)) {
      throw new WtError(`Branch already exists: ${branch}`, {
        code: 'branch_exists',
        hint: `Use \`wt checkout <repo> ${branch}\` to create a worktree for it.`,
      })
    }
    args.push('--no-track', '-b', branch, fullPath, base)
  }

  await git(args, { cwd: gitDir, stream: true })

  if (track) {
    await git(['branch', `--set-upstream-to=${track}`, branch], {
      cwd: gitDir,
      allowFailure: true,
    })
  }

  if (parentBranch) {
    await setConfig(gitDir, PARENT_CONFIG_KEY(branch), parentBranch)
  }

  if (!noSetup) {
    const rootWorktree = existsSync(join(repoPath, 'main'))
      ? join(repoPath, 'main')
      : gitDir
    await runSetupCommands(repoPath, fullPath, rootWorktree)
  }

  return { path: fullPath, branch, base, parent: parentBranch }
}

/** Read the recorded stack parent for a branch, if any. */
export async function stackParentOf(
  gitDir: string,
  branch: string,
): Promise<string | undefined> {
  return getConfig(gitDir, PARENT_CONFIG_KEY(branch))
}

/** Resolve a branch that may exist locally, remotely, or not at all. */
export interface BranchResolution {
  branch: string
  exists: 'local' | 'remote' | 'none'
  track: string | undefined
}

export async function resolveBranchForCheckout(
  gitDir: string,
  branch: string,
  remote = 'origin',
): Promise<BranchResolution> {
  if (await localBranchExists(gitDir, branch)) {
    return { branch, exists: 'local', track: undefined }
  }
  if (await remoteBranchExists(gitDir, branch, remote)) {
    return { branch, exists: 'remote', track: `${remote}/${branch}` }
  }
  return { branch, exists: 'none', track: undefined }
}

/** Worktrees excluding the primary/main checkout. */
export function secondaryWorktrees(
  worktrees: Worktree[],
  gitDir: string,
): Worktree[] {
  const primary = canonical(gitDir)
  return worktrees.filter((wt) => canonical(wt.path) !== primary && !wt.bare)
}
