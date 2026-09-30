import { Command, Option } from 'commander'
import pc from 'picocolors'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor } from '../core/registry.js'
import {
  loadWorktrees,
  arrange,
  flatten,
  rowLabel,
  rowWidths,
  type ViewOptions,
  type WorktreeReport,
} from '../core/worktree-view.js'
import { emitJson, log, getOutputContext } from '../core/output.js'
import { pickRepo, withViewOptions } from './shared.js'

export function listCommand(): Command {
  return withViewOptions(
    new Command('list')
      .alias('ls')
      .description('List worktrees for a repo')
      .argument('[repo]', 'registered repo name or alias')
      .option('--no-status', 'skip the dirty/merged/pushed checks (faster)')
      // Status used to be opt-in; keep the old flag working.
      .addOption(new Option('--status').hideHelp()),
    { sort: 'recent', group: 'none' },
  ).action(async (repoArg, options) => {
    await runList(repoArg, options)
  })
}

async function runList(
  repoArg: string | undefined,
  options: ViewOptions & { status?: boolean },
): Promise<void> {
  const config = await loadConfig()
  const repoName = await pickRepo(config.reposFile, repoArg)
  const repo = await resolveRepo(config.reposFile, repoName)
  const gitDir = await gitDirFor(repo.path)

  const status = options.status ?? true
  const arranged = arrange(await loadWorktrees(gitDir, { status }), options)
  const all = flatten(arranged)

  if (getOutputContext().json) {
    emitJson({ ok: true, repo: repo.name, root: repo.path, worktrees: all })
    return
  }

  if (all.length === 0) {
    log('No worktrees found.')
    return
  }

  const widths = rowWidths(all, { status })
  const row = (report: WorktreeReport) => {
    const branch = pc.dim(report.branch ?? '(detached)')
    log(`  ${rowLabel(report, widths)}  ${branch}`)
  }

  log()
  log(pc.bold(`Worktrees in ${repo.name}`))
  if (arranged.main) row(arranged.main)
  for (const group of arranged.groups) {
    log()
    if (group.title) log(pc.bold(`${group.title} (${group.reports.length})`))
    group.reports.forEach(row)
  }
  log()
}
