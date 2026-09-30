import { Command } from 'commander'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor } from '../core/registry.js'
import { select } from '../core/prompts.js'
import { emitJson, emitCd, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'
import {
  loadWorktrees,
  arrange,
  flatten,
  rowLabel,
  rowWidths,
  matchWorktree,
  type ViewOptions,
  type WorktreeReport,
} from '../core/worktree-view.js'
import { pickRepo, withViewOptions } from './shared.js'
import { runCleanup } from './cleanup.js'

/** Picker value for the cleanup entry. No path can contain NUL. */
const CLEANUP = '\0cleanup'

export function pickCommand(): Command {
  return withViewOptions(
    new Command('pick')
      .alias('cd')
      .description('Select a worktree and cd into it')
      .argument('[repo]', 'registered repo name or alias')
      .argument('[query]', 'directory or branch to match; skips the picker')
      .option('--main', 'jump straight to the main worktree')
      .option('--path-only', 'print the path without the cd sentinel'),
    { sort: 'recent', group: 'none' },
  ).action(async (repoArg, queryArg, options) => {
    await runPick(repoArg, queryArg, options)
  })
}

async function runPick(
  repoArg: string | undefined,
  queryArg: string | undefined,
  options: ViewOptions & { main?: boolean; pathOnly?: boolean },
): Promise<void> {
  const config = await loadConfig()
  const repoName = await pickRepo(config.reposFile, repoArg)
  const repo = await resolveRepo(config.reposFile, repoName)
  const gitDir = await gitDirFor(repo.path)
  const interactive = !options.main && !queryArg
  // Status is only shown in the picker, so skip its cost otherwise.
  const reports = await loadWorktrees(gitDir, { status: interactive })

  if (reports.length === 0) {
    throw new WtError('No worktrees found.', { code: 'no_worktrees' })
  }

  let chosen: WorktreeReport
  if (options.main) {
    chosen = reports.find((report) => report.isMain)!
  } else if (queryArg) {
    chosen = matchWorktree(reports, queryArg, { partial: true })
  } else {
    const all = flatten(arrange(reports, options))
    const widths = rowWidths(all, { status: true })
    const choices = all.map((report) => ({
      value: report.path,
      label: rowLabel(report, widths),
      hint: report.branch ?? 'detached',
    }))
    if (all.length > 1) {
      choices.push({ value: CLEANUP, label: 'Clean up worktrees…', hint: 'grove cleanup' })
    }
    const path = await select(`Worktree in ${repo.name}`, choices, 'A worktree')
    if (path === CLEANUP) {
      await runCleanup(repo.name, [], { trash: true, sort: options.sort, group: 'status' })
      return
    }
    chosen = all.find((report) => report.path === path)!
  }

  if (getOutputContext().json) {
    emitJson({ ok: true, repo: repo.name, path: chosen.path, branch: chosen.branch })
    return
  }

  if (options.pathOnly) {
    process.stdout.write(`${chosen.path}\n`)
    return
  }
  emitCd(chosen.path)
}
