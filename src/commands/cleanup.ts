import { Command } from 'commander'
import pc from 'picocolors'
import { resolve, basename, dirname } from 'node:path'
import { samePath } from '../core/paths.js'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor } from '../core/registry.js'
import { git, listWorktrees, localBranchExists, removeConfigSection } from '../core/git.js'
import { moveToTrash, purgeLocalTrash } from '../core/trash.js'
import { groupMultiselect, multiselect, confirm } from '../core/prompts.js'
import { emitJson, emitCd, log, success, warn, info, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'
import { pickRepo, withViewOptions } from './shared.js'
import {
  loadWorktrees,
  arrange,
  flatten,
  rowLabel,
  rowWidths,
  describeStatus,
  isSafeToRemove,
  matchWorktree,
  type ViewOptions,
  type WorktreeReport,
} from '../core/worktree-view.js'

export function cleanupCommand(): Command {
  return withViewOptions(
    new Command('cleanup')
    .alias('rm')
    .description('Remove finished worktrees')
    .argument('[repo]', 'registered repo name, or "self" for the current one')
    .argument('[worktrees...]', 'worktree directories or branches to remove')
    .option('--merged', 'select every clean worktree that is merged or has no commits of its own')
    .option('--force', 'remove even when dirty or unmerged')
    .option('-y, --yes', 'skip confirmation prompts')
    .option('--delete-branch', 'also delete the local branch')
    .option('--no-trash', 'delete permanently instead of moving to trash')
    .option('--dry-run', 'show what would be removed without removing it'),
    { sort: 'recent', group: 'status' },
  ).action(async (repoArg, worktreeArgs, options) => {
    if (repoArg === 'self') {
      await runCleanupSelf(options)
      return
    }
    await runCleanup(repoArg, worktreeArgs ?? [], options)
  })
}

export interface CleanupOptions extends ViewOptions {
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
  /** The local trash folder it went to, or null for the system trash. */
  trashDir: string | null
  branchDeleted: boolean
  skipped: string | null
}

/**
 * Split outcomes for JSON. A skipped worktree must never appear under
 * `removed`: agents read that key's paths as proof of removal, and the run is
 * still `ok` when every requested worktree was skipped.
 */
function partitionOutcomes(outcomes: RemovalOutcome[]) {
  return {
    removed: outcomes
      .filter((outcome) => outcome.removed)
      .map(({ path, branch, trashed, trashDir, branchDeleted }) => ({
        path,
        branch,
        trashed,
        trashDir,
        branchDeleted,
      })),
    skipped: outcomes
      .filter((outcome) => !outcome.removed)
      .map(({ path, branch, skipped }) => ({ path, branch, reason: skipped ?? 'not removed' })),
  }
}

export async function runCleanup(
  repoArg: string | undefined,
  worktreeArgs: string[],
  options: CleanupOptions,
): Promise<void> {
  const config = await loadConfig()
  const repoName = await pickRepo(config.reposFile, repoArg)
  const repo = await resolveRepo(config.reposFile, repoName)
  const gitDir = await gitDirFor(repo.path)

  const arranged = arrange(await loadWorktrees(gitDir, { status: true }), options)
  const candidates = flatten({ main: undefined, groups: arranged.groups })

  if (candidates.length === 0) {
    if (getOutputContext().json) {
      emitJson({ ok: true, repo: repo.name, removed: [], skipped: [] })
      return
    }
    log('No removable worktrees found.')
    return
  }

  let selected: WorktreeReport[]
  if (worktreeArgs.length > 0) {
    // Exact matches only: a substring could remove the wrong worktree.
    selected = worktreeArgs.map((arg) =>
      matchWorktree(candidates, arg, { partial: false }),
    )
  } else if (options.merged) {
    selected = candidates.filter(isSafeToRemove)
    if (selected.length === 0) {
      if (getOutputContext().json) {
        emitJson({ ok: true, repo: repo.name, removed: [], skipped: [] })
        return
      }
      log('No merged worktrees to clean up.')
      return
    }
  } else {
    const widths = rowWidths(candidates, { status: true })
    const option = (report: WorktreeReport) => ({
      value: report.path,
      label: rowLabel(report, widths).trimEnd(),
    })
    const preselected = candidates.filter(isSafeToRemove).map((report) => report.path)
    const [ungrouped] = arranged.groups
    const chosen =
      ungrouped && !ungrouped.title
        ? await multiselect(
            'Select worktrees to remove',
            ungrouped.reports.map(option),
            'Worktree names',
            preselected,
          )
        : await groupMultiselect(
            'Select worktrees to remove',
            Object.fromEntries(
              arranged.groups.map((group) => [
                `${group.title} (${group.reports.length})`,
                group.reports.map(option),
              ]),
            ),
            'Worktree names',
            preselected,
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
      log(`  ${report.dir}  ${pc.dim(describeStatus(report))}`)
    }
    log()
    return
  }

  const proceed = await confirm(`Remove ${selected.length} worktree(s)?`, {
    assumeYes: (options.yes ?? false) || (options.force ?? false),
    defaultValue: false,
    what: 'Removing worktrees',
  })
  if (!proceed) {
    log('Cancelled.')
    return
  }

  const outcomes: RemovalOutcome[] = []
  const useTrash = options.trash && config.useTrash

  for (const report of selected) {
    outcomes.push(
      await removeOne(gitDir, report, {
        force: options.force ?? false,
        deleteBranch: options.deleteBranch ?? false,
        useTrash,
      }),
    )
  }

  if (getOutputContext().json) {
    emitJson({ ok: true, repo: repo.name, ...partitionOutcomes(outcomes) })
    return
  }

  log()
  for (const outcome of outcomes) {
    if (outcome.skipped) {
      warn(`Skipped ${basename(outcome.path)}: ${outcome.skipped}`)
    } else {
      const suffix = trashNote(outcome)
      const branchNote = outcome.branchDeleted
        ? pc.dim(`, deleted branch ${outcome.branch}`)
        : ''
      success(`Removed ${basename(outcome.path)}${suffix}${branchNote}`)
    }
  }
  log()
}

async function removeOne(
  gitDir: string,
  report: WorktreeReport,
  options: {
    force: boolean
    deleteBranch: boolean
    useTrash: boolean
  },
): Promise<RemovalOutcome> {
  const outcome: RemovalOutcome = {
    path: report.path,
    branch: report.branch,
    removed: false,
    trashed: false,
    trashDir: null,
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

  // `git worktree remove` always deletes the directory permanently, so move
  // the directory to the trash first and then prune the stale registration.
  // A failed trash move must not silently become a permanent deletion.
  if (options.useTrash) {
    const locked = await isLocked(gitDir, report.path)
    if (locked && !options.force) {
      outcome.skipped = 'worktree is locked; pass --force to remove'
      return outcome
    }

    // Before the move, so this removal's own entry is never the one purged.
    await purgeLocalTrash(dirname(report.path))
    const destination = await moveToTrash(report.path)
    if (destination) {
      outcome.removed = true
      outcome.trashed = true
      outcome.trashDir = destination === 'system' ? null : destination
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
    outcome.skipped =
      'could not move worktree to trash; pass --no-trash to delete permanently'
    return outcome
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
  if (outcome.branchDeleted) {
    await removeConfigSection(gitDir, `branch.${report.branch}`)
  }
}

function trashNote(outcome: RemovalOutcome): string {
  if (outcome.trashDir) return pc.dim(` (moved to ${outcome.trashDir})`)
  return outcome.trashed ? pc.dim(' (moved to trash)') : ''
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

  const reports = await loadWorktrees(gitRoot, { status: true })
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
    log(`Would remove ${report.dir} ${pc.dim(describeStatus(report))}`)
    return
  }

  const config = await loadConfig()
  const useTrash = options.trash && config.useTrash

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
    deleteBranch: options.deleteBranch ?? false,
    useTrash,
  })

  if (getOutputContext().json) {
    emitJson({ ok: true, ...partitionOutcomes([outcome]), cd: outcome.removed ? gitRoot : null })
    return
  }

  if (outcome.skipped) {
    warn(`Skipped: ${outcome.skipped}`)
    return
  }
  success(`Removed ${report.dir}${trashNote(outcome)}`)
  // The shell is now inside a deleted directory; move it somewhere valid.
  info(`Returning to ${gitRoot}`)
  emitCd(gitRoot)
}
