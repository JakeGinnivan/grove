import { Command } from 'commander'
import pc from 'picocolors'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor } from '../core/registry.js'
import { worktreeDirForBranch } from '../core/naming.js'
import {
  createWorktree,
  resolveBase,
  resolveBranchForCheckout,
} from '../core/worktree.js'
import { git, listWorktrees } from '../core/git.js'
import { requireText } from '../core/prompts.js'
import { emitJson, emitCd, log, success, info, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'
import { pickRepo } from './shared.js'

export function checkoutCommand(): Command {
  return new Command('checkout')
    .alias('co')
    .description('Check out an existing branch into a new worktree')
    .argument('[repo]', 'registered repo name or alias')
    .argument('[branch]', 'branch to check out (prompts when omitted)')
    .option('-d, --dir <name>', 'override the generated worktree directory name')
    .option('--create', 'create the branch if it does not exist')
    .option(
      '--on <branch|worktree>',
      'when creating, stack on this branch or worktree',
    )
    .option('--base <ref>', 'when creating, base the branch on this ref')
    .option('--no-fetch', 'skip fetching origin first')
    .option('--no-setup', 'skip repo-defined worktree setup commands')
    .action(async (repoArg, branchArg, options) => {
      await runCheckout(repoArg, branchArg, options)
    })
}

interface CheckoutOptions {
  dir?: string
  create?: boolean
  on?: string
  base?: string
  fetch: boolean
  setup: boolean
}

async function runCheckout(
  repoArg: string | undefined,
  branchArg: string | undefined,
  options: CheckoutOptions,
): Promise<void> {
  const config = await loadConfig()
  const repoName = await pickRepo(config.reposFile, repoArg)
  const repo = await resolveRepo(config.reposFile, repoName)
  const gitDir = await gitDirFor(repo.path)

  // Fetch before resolving so a freshly pushed remote branch is visible.
  if (options.fetch) {
    info('Fetching origin...')
    await git(['fetch', 'origin', '--prune'], { cwd: gitDir, allowFailure: true })
  }

  const branch = await requireText(branchArg, {
    message: 'Which branch?',
    flag: '--create with a branch name, or pass the branch argument',
    what: 'A branch name',
    placeholder: 'feature/some-branch',
  })

  const resolution = await resolveBranchForCheckout(gitDir, branch)

  if (resolution.exists === 'none' && !options.create) {
    throw new WtError(`Branch not found locally or on origin: ${branch}`, {
      code: 'branch_not_found',
      hint: 'Pass --create to create it, or use `wt new` for a generated name.',
    })
  }

  const existing = (await listWorktrees(gitDir)).find(
    (wt) => wt.branch === branch,
  )
  if (existing) {
    if (getOutputContext().json) {
      emitJson({
        ok: true,
        repo: repo.name,
        path: existing.path,
        branch,
        created: false,
        note: 'Branch was already checked out in this worktree.',
      })
      return
    }
    info(`Branch ${pc.cyan(branch)} is already checked out.`)
    emitCd(existing.path)
    return
  }

  const worktreeDir = options.dir ?? worktreeDirForBranch(branch)

  // A local branch is checked out as-is. A remote-only branch gets a local
  // branch tracking it. A brand new branch is created from the base.
  let created: Awaited<ReturnType<typeof createWorktree>>
  if (resolution.exists === 'local') {
    created = await createWorktree({
      repoPath: repo.path,
      gitDir,
      worktreeDir,
      branch,
      useExistingBranch: true,
      noFetch: true,
      noSetup: !options.setup,
    })
  } else if (resolution.exists === 'remote') {
    // `worktree add <path> <branch>` with no local branch creates one that
    // tracks origin/<branch> via git's DWIM behaviour.
    created = await createWorktree({
      repoPath: repo.path,
      gitDir,
      worktreeDir,
      branch,
      useExistingBranch: true,
      track: resolution.track,
      noFetch: true,
      noSetup: !options.setup,
    })
  } else {
    const { base, parent } = await resolveBase(gitDir, {
      base: options.base,
      on: options.on,
      repoPath: repo.path,
    })
    created = await createWorktree({
      repoPath: repo.path,
      gitDir,
      worktreeDir,
      branch,
      base,
      parentBranch: parent,
      noFetch: true,
      noSetup: !options.setup,
    })
  }

  if (getOutputContext().json) {
    emitJson({
      ok: true,
      repo: repo.name,
      path: created.path,
      branch: created.branch,
      base: created.base,
      parent: created.parent ?? null,
      created: resolution.exists === 'none',
      source: resolution.exists,
    })
    return
  }

  log()
  success(`Checked out ${pc.cyan(branch)} at ${created.path}`)
  emitCd(created.path)
}
