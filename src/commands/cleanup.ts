import { Command } from 'commander'
import pc from 'picocolors'
import { resolve, basename, dirname } from 'node:path'
import { samePath } from '../core/paths.js'
import { loadConfig, type GroveConfig } from '../core/config.js'
import { resolveRepo, gitDirFor, readRegistry } from '../core/registry.js'
import {
  git,
  listWorktrees,
  localBranchExists,
  removeConfigSection,
  splitUpstream,
} from '../core/git.js'
import { moveToTrash, purgeLocalTrash } from '../core/trash.js'
import { groupMultiselect, multiselect, confirm, type ToggleAll } from '../core/prompts.js'
import { emitJson, emitCd, log, success, warn, info, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'
import { ALL_REPOS, pickRepo, withViewOptions } from './shared.js'
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
    .option('--all', 'pick from every registered repo\'s worktrees')
    .option('--merged', 'select every clean worktree that is merged or has no commits of its own')
    .option('--force', 'remove even when dirty or unmerged')
    .option('-y, --yes', 'skip confirmation prompts')
    .option('--delete-branch', 'also delete the local branch')
    .option('--delete-remote-branch', 'also delete the branch on its remote, if it is still there')
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
  all?: boolean
  merged?: boolean
  force?: boolean
  yes?: boolean
  deleteBranch?: boolean
  deleteRemoteBranch?: boolean
  trash: boolean
  dryRun?: boolean
}

interface RemovalOutcome {
  /** Set when removing from a picker, unset for `cleanup self`. */
  repo?: string
  path: string
  branch: string | null
  removed: boolean
  trashed: boolean
  /** The local trash folder it went to, or null for the system trash. */
  trashDir: string | null
  branchDeleted: boolean
  /** The remote branch, e.g. `origin/x`, when `--delete-remote-branch` deleted it. */
  remoteBranchDeleted: string | null
  /** Why `--delete-remote-branch` could not delete it, if it tried and failed. */
  remoteBranchError: string | null
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
      .map(
        ({
          repo,
          path,
          branch,
          trashed,
          trashDir,
          branchDeleted,
          remoteBranchDeleted,
          remoteBranchError,
        }) => ({
          ...(repo ? { repo } : {}),
          path,
          branch,
          trashed,
          trashDir,
          branchDeleted,
          remoteBranchDeleted,
          remoteBranchError,
        }),
      ),
    skipped: outcomes
      .filter((outcome) => !outcome.removed)
      .map(({ repo, path, branch, skipped }) => ({
        ...(repo ? { repo } : {}),
        path,
        branch,
        reason: skipped ?? 'not removed',
      })),
  }
}

export async function runCleanup(
  repoArg: string | undefined,
  worktreeArgs: string[],
  options: CleanupOptions,
): Promise<void> {
  const config = await loadConfig()
  if (options.all && (repoArg !== undefined || worktreeArgs.length > 0)) {
    throw new WtError('--all takes no repo or worktree arguments.', {
      code: 'conflicting_arguments',
      hint: 'Drop --all to clean up one repo, or drop the arguments to pick from every repo.',
    })
  }
  const repoName = options.all
    ? ALL_REPOS
    : await pickRepo(config.reposFile, repoArg, { worktreeCounts: true, includeAll: true })
  if (repoName === ALL_REPOS) {
    await runCleanupAll(config, options)
    return
  }
  const repo = await resolveRepo(config.reposFile, repoName)
  const gitDir = await gitDirFor(repo.path)

  const arranged = arrange(await loadWorktrees(gitDir, { status: true }), options)
  const candidates = flatten({ main: undefined, groups: arranged.groups })
  const scope = { repo: repo.name }

  if (candidates.length === 0) {
    nothingToRemove(scope, 'No removable worktrees found.')
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
      nothingToRemove(scope, 'No merged worktrees to clean up.')
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
            safeToggle(preselected),
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
            safeToggle(preselected),
          )
    selected = candidates.filter((report) => chosen.includes(report.path))
    options = await askDeleteRemoteBranch(selected, options)
  }

  await removeTargets(
    selected.map((report) => ({ repo: repo.name, gitDir, report })),
    scope,
    config.useTrash,
    options,
  )
}

/**
 * `a` in the picker selects only what is safe to remove, the same set the
 * picker starts with. Worktrees with work to lose are picked one at a time.
 */
function safeToggle(paths: string[]): ToggleAll {
  return { label: 'merged & clean', values: paths }
}

/**
 * Having picked worktrees by hand, also offer to delete their remote
 * branches, unless the flag already asked for it or none has one.
 */
async function askDeleteRemoteBranch(
  selected: WorktreeReport[],
  options: CleanupOptions,
): Promise<CleanupOptions> {
  if (options.deleteRemoteBranch || options.dryRun) return options
  const pushed = selected.filter((report) => report.upstream).length
  if (pushed === 0) return options
  const deleteRemoteBranch = await confirm(
    `Also delete the remote branch of ${pushed} pushed worktree(s)?`,
    { assumeYes: false, defaultValue: false, what: 'Deleting remote branches' },
  )
  return { ...options, deleteRemoteBranch }
}

/** A worktree picked for removal, and the repo it belongs to. */
interface Target {
  repo: string
  gitDir: string
  report: WorktreeReport
}

/** JSON's top level names the one repo cleaned up, or every repo looked at. */
type Scope = { repo: string } | { repos: string[] }

function nothingToRemove(scope: Scope, message: string): void {
  if (getOutputContext().json) {
    emitJson({ ok: true, ...scope, removed: [], skipped: [] })
    return
  }
  log(message)
}

/**
 * `cleanup --all`, or "All repos" in the repo picker: one picker over every
 * repo's worktrees, grouped by repo instead of by status.
 */
async function runCleanupAll(config: GroveConfig, options: CleanupOptions): Promise<void> {
  const entries = (await readRegistry(config.reposFile)).filter((entry) => !entry.aliasOf)
  if (entries.length === 0) {
    throw new WtError('No repos registered.', {
      code: 'no_repos',
      hint: 'Use `wt clone <url>` or `wt import <path>` first.',
    })
  }

  const loaded = await Promise.all(
    entries.map(async (entry) => {
      try {
        const gitDir = await gitDirFor(entry.path)
        const arranged = arrange(await loadWorktrees(gitDir, { status: true }), options)
        const reports = flatten({ main: undefined, groups: arranged.groups })
        return { name: entry.name, gitDir, reports }
      } catch (error) {
        // One broken registry entry must not block cleaning up the rest.
        warn(`Skipping ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }),
  )
  const repos = loaded.filter(
    (repo): repo is NonNullable<typeof repo> => repo !== undefined && repo.reports.length > 0,
  )
  const scope = { repos: repos.map((repo) => repo.name) }
  const candidates: Target[] = repos.flatMap((repo) =>
    repo.reports.map((report) => ({ repo: repo.name, gitDir: repo.gitDir, report })),
  )

  if (candidates.length === 0) {
    nothingToRemove(scope, 'No removable worktrees found.')
    return
  }

  let selected: Target[]
  if (options.merged) {
    selected = candidates.filter((target) => isSafeToRemove(target.report))
    if (selected.length === 0) {
      nothingToRemove(scope, 'No merged worktrees to clean up.')
      return
    }
  } else {
    const safe = candidates
      .filter((target) => isSafeToRemove(target.report))
      .map((target) => target.report.path)
    const widths = rowWidths(
      candidates.map((target) => target.report),
      { status: true },
    )
    const chosen = await groupMultiselect(
      'Select worktrees to remove',
      Object.fromEntries(
        repos.map((repo) => [
          `${repo.name} (${repo.reports.length})`,
          repo.reports.map((report) => ({
            value: report.path,
            label: rowLabel(report, widths).trimEnd(),
          })),
        ]),
      ),
      'Worktree names',
      safe,
      safeToggle(safe),
    )
    selected = candidates.filter((target) => chosen.includes(target.report.path))
    options = await askDeleteRemoteBranch(
      selected.map((target) => target.report),
      options,
    )
  }

  await removeTargets(selected, scope, config.useTrash, options)
}

async function removeTargets(
  targets: Target[],
  scope: Scope,
  configUseTrash: boolean,
  options: CleanupOptions,
): Promise<void> {
  if (targets.length === 0) {
    log('Nothing selected.')
    return
  }

  const repoCount = new Set(targets.map((target) => target.repo)).size
  // Across repos, worktree directory names alone can be ambiguous.
  const name = (repo: string | undefined, path: string) =>
    'repos' in scope && repo ? `${repo}/${basename(path)}` : basename(path)

  if (options.dryRun) {
    if (getOutputContext().json) {
      emitJson({
        ok: true,
        dryRun: true,
        ...scope,
        wouldRemove: targets.map(({ repo, report }) => ({
          repo,
          path: report.path,
          branch: report.branch,
          upstream: report.upstream,
          dirty: report.dirty,
          merged: report.merged,
        })),
      })
      return
    }
    log()
    log(pc.bold('Would remove:'))
    for (const { repo, report } of targets) {
      const remoteNote =
        options.deleteRemoteBranch && report.upstream ? `, delete ${report.upstream}` : ''
      log(`  ${name(repo, report.path)}  ${pc.dim(describeStatus(report) + remoteNote)}`)
    }
    log()
    return
  }

  const across = repoCount > 1 ? ` across ${repoCount} repos` : ''
  const proceed = await confirm(`Remove ${targets.length} worktree(s)${across}?`, {
    assumeYes: (options.yes ?? false) || (options.force ?? false),
    defaultValue: false,
    what: 'Removing worktrees',
  })
  if (!proceed) {
    log('Cancelled.')
    return
  }

  const outcomes: RemovalOutcome[] = []
  const useTrash = options.trash && configUseTrash
  for (const { repo, gitDir, report } of targets) {
    const outcome = await removeOne(gitDir, report, {
      force: options.force ?? false,
      deleteBranch: options.deleteBranch ?? false,
      deleteRemoteBranch: options.deleteRemoteBranch ?? false,
      useTrash,
    })
    outcomes.push({ ...outcome, repo })
  }

  if (getOutputContext().json) {
    emitJson({ ok: true, ...scope, ...partitionOutcomes(outcomes) })
    return
  }

  log()
  for (const outcome of outcomes) {
    const label = name(outcome.repo, outcome.path)
    if (outcome.skipped) {
      warn(`Skipped ${label}: ${outcome.skipped}`)
    } else {
      const suffix = trashNote(outcome)
      const branchNote = outcome.branchDeleted
        ? pc.dim(`, deleted branch ${outcome.branch}`)
        : ''
      success(`Removed ${label}${suffix}${branchNote}${remoteNote(outcome)}`)
      if (outcome.remoteBranchError) warn(outcome.remoteBranchError)
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
    deleteRemoteBranch: boolean
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
    remoteBranchDeleted: null,
    remoteBranchError: null,
    skipped: null,
  }

  // Losing unpushed work needs a stronger signal than --yes: only --force
  // (or an explicit interactive confirmation) discards it. This keeps an
  // agent running `cleanup --yes` from destroying uncommitted changes.
  const risks: string[] = []
  if (report.dirty) risks.push('uncommitted changes')
  if (report.ahead > 0) risks.push(`${report.ahead} unpushed commit(s)`)
  if (!report.merged && !report.upstream) risks.push('not merged, no upstream')
  // The remote copy is what made an unmerged branch safe to drop, and on most
  // hosts deleting a PR's branch closes the PR.
  const remote = options.deleteRemoteBranch ? await remoteRisks(gitDir, report) : []
  risks.push(...remote)

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

    // Ignored files (node_modules, build output) are regenerable and make the
    // trash huge and slow to fill. -X rather than -x: a forced removal of a
    // dirty worktree must keep its untracked work recoverable in the trash.
    const cleaned = await git(['clean', '-dfX'], {
      cwd: report.path,
      allowFailure: true,
    })
    if (cleaned.exitCode !== 0) {
      warn(`Could not remove ignored files from ${report.path} before trashing it.`)
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
      await deleteBranches(gitDir, report, options, outcome)
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

  await deleteBranches(gitDir, report, options, outcome)
  return outcome
}

/** What deleting the worktree's remote branch would lose. */
async function remoteRisks(gitDir: string, report: WorktreeReport): Promise<string[]> {
  if (!report.branch || !report.upstream) return []
  const risks: string[] = []
  if (!report.merged) risks.push(`an unmerged remote branch ${report.upstream}`)
  const behind = await git(
    ['rev-list', '--count', `refs/heads/${report.branch}..refs/remotes/${report.upstream}`],
    { cwd: gitDir, allowFailure: true },
  )
  const count = Number.parseInt(behind.stdout, 10)
  if (behind.exitCode === 0 && count > 0) {
    risks.push(`${count} commit(s) on ${report.upstream} not in the local branch`)
  }
  return risks
}

async function deleteBranches(
  gitDir: string,
  report: WorktreeReport,
  options: { deleteBranch: boolean; deleteRemoteBranch: boolean },
  outcome: RemovalOutcome,
): Promise<void> {
  if (options.deleteRemoteBranch) await deleteRemoteBranch(gitDir, report, outcome)
  await deleteBranchIfRequested(gitDir, report, options, outcome)
}

/**
 * Delete the upstream branch on its remote. A branch already deleted there,
 * say on merge, is not an error. The lease refuses the delete when the
 * remote has moved since the last fetch, so commits we never saw survive.
 */
async function deleteRemoteBranch(
  gitDir: string,
  report: WorktreeReport,
  outcome: RemovalOutcome,
): Promise<void> {
  if (!report.upstream) return
  const target = await splitUpstream(gitDir, report.upstream)
  if (!target) {
    outcome.remoteBranchError = `Could not tell which remote ${report.upstream} is on; left it in place.`
    return
  }
  const trackingRef = `refs/remotes/${report.upstream}`
  const expected = await git(['rev-parse', '--verify', '--quiet', trackingRef], {
    cwd: gitDir,
    allowFailure: true,
  })
  const lease = expected.stdout
    ? `--force-with-lease=refs/heads/${target.branch}:${expected.stdout}`
    : '--force-with-lease'
  const pushed = await git(['push', lease, '--delete', target.remote, target.branch], {
    cwd: gitDir,
    allowFailure: true,
  })
  if (pushed.exitCode === 0) {
    outcome.remoteBranchDeleted = report.upstream
    return
  }
  if (/remote ref does not exist/.test(pushed.stderr)) {
    await git(['update-ref', '-d', trackingRef], { cwd: gitDir, allowFailure: true })
    return
  }
  // git's last line is a generic "failed to push"; the rejection says why.
  const lines = pushed.stderr.split('\n').map((line) => line.trim()).filter(Boolean)
  const reason =
    lines.find((line) => /^(!|fatal:)/.test(line)) ?? lines.at(-1) ?? 'git push failed'
  outcome.remoteBranchError = `Could not delete ${report.upstream}: ${reason}`
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

function remoteNote(outcome: RemovalOutcome): string {
  return outcome.remoteBranchDeleted
    ? pc.dim(`, deleted remote branch ${outcome.remoteBranchDeleted}`)
    : ''
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
    deleteRemoteBranch: options.deleteRemoteBranch ?? false,
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
  success(`Removed ${report.dir}${trashNote(outcome)}${remoteNote(outcome)}`)
  if (outcome.remoteBranchError) warn(outcome.remoteBranchError)
  // The shell is now inside a deleted directory; move it somewhere valid.
  info(`Returning to ${gitRoot}`)
  emitCd(gitRoot)
}
