import { Command } from 'commander'
import pc from 'picocolors'
import { resolve, basename, dirname } from 'node:path'
import { canonical, samePath } from '../core/paths.js'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor } from '../core/registry.js'
import { git, listWorktrees, localBranchExists } from '../core/git.js'
import { canTrash, moveToTrash } from '../core/trash.js'
import { multiselect, confirm } from '../core/prompts.js'
import { emitJson, emitCd, log, success, warn, info, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'
import { pickRepo } from './shared.js'
import { gatherWorktrees, type WorktreeReport } from './list.js'

export function cleanupCommand(): Command {
  return new Command('cleanup')
    .alias('rm')
    .description('Remove finished worktrees')
    .argument('[repo]', 'registered repo name, or "self" for the current one')
    .argument('[worktrees...]', 'worktree directories or branches to remove')
    .option('--merged', 'select all worktrees merged into the default branch')
    .option('--force', 'remove even when dirty or unmerged')
    .option('-y, --yes', 'skip confirmation prompts')
    .option('--delete-branch', 'also delete the local branch')
    .option('--no-trash', 'delete permanently instead of moving to trash')
    .option('--dry-run', 'show what would be removed without removing it')
    .action(async (repoArg, worktreeArgs, options) => {
      if (repoArg === 'self') {
        await runCleanupSelf(options)
        return
      }
      await runCleanup(repoArg, worktreeArgs ?? [], options)
    })
}

interface CleanupOptions {
  merged?: boolean
  force?: boolean
  yes?: boolean
  deleteBranch?: boolean
  trash: boolean
  dryRun?: boolean
}

interface RemovalOutcome {
  path: string
  branch: string | null
  removed: boolean
  trashed: boolean
  branchDeleted: boolean
  skipped: string | null
}

async function runCleanup(
  repoArg: string | undefined,
  worktreeArgs: string[],
  options: CleanupOptions,
): Promise<void> {
  const config = await loadConfig()
  const repoName = await pickRepo(config.reposFile, repoArg)
  const repo = await resolveRepo(config.reposFile, repoName)
  const gitDir = await gitDirFor(repo.path)

  const all = await gatherWorktrees(gitDir, true)
  const primary = canonical(gitDir)
  const candidates = all.filter((report) => canonical(report.path) !== primary)

  if (candidates.length === 0) {
    if (getOutputContext().json) {
      emitJson({ ok: true, repo: repo.name, removed: [] })
      return
    }
    log('No removable worktrees found.')
    return
  }

  let selected: WorktreeReport[]
  if (worktreeArgs.length > 0) {
    selected = worktreeArgs.map((arg) => {
      const match = candidates.find(
        (report) =>
          report.dir === arg ||
          report.branch === arg ||
          samePath(report.path, arg),
      )
      if (!match) {
        throw new WtError(`No worktree matching "${arg}".`, {
          code: 'no_matching_worktree',
          hint: `Available: ${candidates.map((c) => c.dir).join(', ')}`,
        })
      }
      return match
    })
  } else if (options.merged) {
    selected = candidates.filter((report) => report.merged && !report.dirty)
    if (selected.length === 0) {
      if (getOutputContext().json) {
        emitJson({ ok: true, repo: repo.name, removed: [] })
        return
      }
      log('No merged worktrees to clean up.')
      return
    }
  } else {
    const chosen = await multiselect(
      'Select worktrees to remove',
      candidates.map((report) => ({
        value: report.path,
        label: report.dir,
        hint: describeFlags(report),
      })),
      'Worktree names',
    )
    selected = candidates.filter((report) => chosen.includes(report.path))
  }

  if (selected.length === 0) {
    log('Nothing selected.')
    return
  }

  if (options.dryRun) {
    if (getOutputContext().json) {
      emitJson({
        ok: true,
        dryRun: true,
        repo: repo.name,
        wouldRemove: selected.map((report) => ({
          path: report.path,
          branch: report.branch,
          dirty: report.dirty,
          merged: report.merged,
        })),
      })
      return
    }
    log()
    log(pc.bold('Would remove:'))
    for (const report of selected) {
      log(`  ${report.dir}  ${pc.dim(describeFlags(report) || 'clean')}`)
    }
    log()
    return
  }

  const outcomes: RemovalOutcome[] = []
  const useTrash = options.trash && config.useTrash && (await canTrash())

  for (const report of selected) {
    outcomes.push(
      await removeOne(gitDir, report, {
        force: options.force ?? false,
        yes: options.yes ?? false,
        deleteBranch: options.deleteBranch ?? false,
        useTrash,
      }),
    )
  }

  if (getOutputContext().json) {
    emitJson({ ok: true, repo: repo.name, removed: outcomes })
    return
  }

  log()
  for (const outcome of outcomes) {
    if (outcome.skipped) {
      warn(`Skipped ${basename(outcome.path)}: ${outcome.skipped}`)
    } else {
      const suffix = outcome.trashed ? pc.dim(' (moved to trash)') : ''
      const branchNote = outcome.branchDeleted
        ? pc.dim(`, deleted branch ${outcome.branch}`)
        : ''
      success(`Removed ${basename(outcome.path)}${suffix}${branchNote}`)
    }
  }
  log()
}

function describeFlags(report: WorktreeReport): string {
  const flags: string[] = []
  if (report.dirty) flags.push('dirty')
  if (report.ahead > 0) flags.push(`${report.ahead} unpushed`)
  if (report.merged) flags.push('merged')
  if (!report.upstream && !report.merged) flags.push('no upstream')
  return flags.join(', ')
}

async function removeOne(
  gitDir: string,
  report: WorktreeReport,
  options: {
    force: boolean
    yes: boolean
    deleteBranch: boolean
    useTrash: boolean
  },
): Promise<RemovalOutcome> {
  const outcome: RemovalOutcome = {
    path: report.path,
    branch: report.branch,
    removed: false,
    trashed: false,
    branchDeleted: false,
    skipped: null,
  }

  // Losing unpushed work needs a stronger signal than --yes: only --force
  // (or an explicit interactive confirmation) discards it. This keeps an
  // agent running `cleanup --yes` from destroying uncommitted changes.
  const risks: string[] = []
  if (report.dirty) risks.push('uncommitted changes')
  if (report.ahead > 0) risks.push(`${report.ahead} unpushed commit(s)`)
  if (!report.merged && !report.upstream) risks.push('not merged, no upstream')

  if (risks.length > 0 && !options.force) {
    const proceed = await confirm(
      `${basename(report.path)} has ${risks.join(' and ')}. Remove anyway?`,
      {
        assumeYes: false,
        defaultValue: false,
        what: `Removing ${basename(report.path)} (${risks.join(', ')})`,
      },
    ).catch((error) => {
      // Non-interactive: report as a skip rather than failing the whole run.
      if (error instanceof WtError && error.code === 'needs_input') return false
      throw error
    })
    if (!proceed) {
      outcome.skipped = `has ${risks.join(' and ')}; pass --force to remove`
      return outcome
    }
  }

  // `git worktree remove` always deletes the directory permanently, so to
  // keep the files recoverable we move the directory to the trash first and
  // then prune the now-stale registration. Falling back to git's own removal
  // when trashing is unavailable or fails.
  if (options.useTrash) {
    const locked = await isLocked(gitDir, report.path)
    if (locked && !options.force) {
      outcome.skipped = 'worktree is locked; pass --force to remove'
      return outcome
    }

    if (await moveToTrash(report.path)) {
      outcome.removed = true
      outcome.trashed = true
      const pruned = await git(['worktree', 'prune'], {
        cwd: gitDir,
        allowFailure: true,
      })
      if (pruned.exitCode !== 0) {
        warn(`Moved ${report.path} to trash, but pruning the worktree failed.`)
      }
      await deleteBranchIfRequested(gitDir, report, options, outcome)
      return outcome
    }
    warn(`Could not move ${report.path} to trash; deleting instead.`)
  }

  const args = ['worktree', 'remove']
  if (report.dirty || options.force) args.push('--force')
  args.push(report.path)

  const result = await git(args, { cwd: gitDir, allowFailure: true })
  if (result.exitCode !== 0) {
    outcome.skipped = result.stderr.split('\n')[0] ?? 'git worktree remove failed'
    return outcome
  }
  outcome.removed = true

  await deleteBranchIfRequested(gitDir, report, options, outcome)
  return outcome
}

async function deleteBranchIfRequested(
  gitDir: string,
  report: WorktreeReport,
  options: { deleteBranch: boolean },
  outcome: RemovalOutcome,
): Promise<void> {
  if (!options.deleteBranch || !report.branch) return
  if (!(await localBranchExists(gitDir, report.branch))) return
  const del = await git(['branch', '-D', report.branch], {
    cwd: gitDir,
    allowFailure: true,
  })
  outcome.branchDeleted = del.exitCode === 0
}

/** True when git has the worktree marked as locked. */
async function isLocked(gitDir: string, path: string): Promise<boolean> {
  const worktrees = await listWorktrees(gitDir)
  return worktrees.some((wt) => samePath(wt.path, path) && wt.locked)
}

/** `wt cleanup self` — remove the worktree the user is currently inside. */
async function runCleanupSelf(options: CleanupOptions): Promise<void> {
  const cwd = process.cwd()
  const top = await git(['rev-parse', '--show-toplevel'], {
    cwd,
    allowFailure: true,
  })
  if (top.exitCode !== 0 || !top.stdout) {
    throw new WtError('Not inside a git worktree.', { code: 'not_in_worktree' })
  }
  const worktreePath = top.stdout

  const commonDirResult = await git(['rev-parse', '--git-common-dir'], {
    cwd: worktreePath,
  })
  const commonDir = resolve(worktreePath, commonDirResult.stdout)
  const gitRoot = commonDir.endsWith('.git') ? dirname(commonDir) : commonDir

  if (samePath(worktreePath, gitRoot)) {
    throw new WtError('Refusing to remove the main worktree.', {
      code: 'is_main_worktree',
      hint: 'Use `wt cleanup <repo>` to pick a different worktree.',
    })
  }

  const reports = await gatherWorktrees(gitRoot, true)
  const report = reports.find((candidate) =>
    samePath(candidate.path, worktreePath),
  )
  if (!report) {
    throw new WtError('Could not identify the current worktree.', {
      code: 'worktree_not_found',
    })
  }

  if (options.dryRun) {
    if (getOutputContext().json) {
      emitJson({ ok: true, dryRun: true, wouldRemove: [report] })
      return
    }
    log(`Would remove ${report.dir} ${pc.dim(describeFlags(report))}`)
    return
  }

  const config = await loadConfig()
  const useTrash = options.trash && config.useTrash && (await canTrash())

  if (!options.yes && !options.force) {
    const proceed = await confirm(`Remove the current worktree ${report.dir}?`, {
      assumeYes: false,
      defaultValue: false,
      what: 'Removing the current worktree',
    })
    if (!proceed) {
      log('Cancelled.')
      return
    }
  }

  const outcome = await removeOne(gitRoot, report, {
    force: options.force ?? false,
    yes: options.yes ?? false,
    deleteBranch: options.deleteBranch ?? false,
    useTrash,
  })

  if (getOutputContext().json) {
    emitJson({ ok: true, removed: [outcome], cd: outcome.removed ? gitRoot : null })
    return
  }

  if (outcome.skipped) {
    warn(`Skipped: ${outcome.skipped}`)
    return
  }
  success(`Removed ${report.dir}`)
  // The shell is now inside a deleted directory; move it somewhere valid.
  info(`Returning to ${gitRoot}`)
  emitCd(gitRoot)
}
