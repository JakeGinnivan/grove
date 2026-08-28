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
import { git, listWorktrees, listBranches } from '../core/git.js'
import { canPrompt, requireText, searchSelect } from '../core/prompts.js'
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
    .option('--setup', 'run trusted repo-defined worktree setup commands', false)
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

/**
 * Resolve the branch argument, showing a searchable list of branches when it
 * is omitted.
 *
 * `--create` means the user is naming a branch that does not exist yet, so
 * there is nothing to list and the free-text prompt stands. The list is also
 * skipped when the repo has no branches to offer, which leaves the original
 * prompt (and its non-interactive error) as the fallback in every case the
 * picker cannot serve.
 */
async function pickBranch(
  provided: string | undefined,
  gitDir: string,
  options: CheckoutOptions,
): Promise<string> {
  const freeText = () =>
    requireText(provided, {
      message: 'Which branch?',
      flag: '--create with a branch name, or pass the branch argument',
      what: 'A branch name',
      placeholder: 'feature/some-branch',
    })

  if (provided || options.create || !canPrompt()) return freeText()

  const [branches, worktrees] = await Promise.all([
    listBranches(gitDir),
    listWorktrees(gitDir),
  ])
  if (branches.length === 0) return freeText()

  const checkedOut = new Set(
    worktrees.flatMap((wt) => (wt.branch ? [wt.branch] : [])),
  )

  return searchSelect(
    'Which branch?',
    branches.map((branch) => ({
      value: branch.name,
      label: branch.name,
      // Branches already in a worktree stay selectable: checkout cds to the
      // existing one, which is a reasonable thing to have asked for.
      hint: checkedOut.has(branch.name)
        ? `already checked out • ${branch.relativeDate}`
        : [
            branch.source === 'remote' ? 'origin' : 'local',
            branch.relativeDate,
            branch.subject,
          ]
            .filter(Boolean)
            .join(' • '),
    })),
    'A branch name',
    // Five rows keeps the prompt compact: the branches worth checking out are
    // almost always the recently committed ones at the top, and anything
    // older is a scroll or a search away.
    { placeholder: 'type to filter', maxItems: 5 },
  )
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

  const branch = await pickBranch(branchArg, gitDir, options)

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
      setup: options.setup,
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
      setup: options.setup,
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
      setup: options.setup,
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
