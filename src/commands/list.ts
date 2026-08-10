import { Command } from 'commander'
import pc from 'picocolors'
import { basename } from 'node:path'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor } from '../core/registry.js'
import {
  listWorktrees,
  isDirty,
  upstreamOf,
  aheadCount,
  defaultBase,
  isMergedInto,
} from '../core/git.js'
import { stackParentOf } from '../core/worktree.js'
import { emitJson, log, getOutputContext } from '../core/output.js'
import { pickRepo } from './shared.js'

export interface WorktreeReport {
  path: string
  dir: string
  branch: string | null
  isMain: boolean
  dirty: boolean
  upstream: string | null
  ahead: number
  merged: boolean
  parent: string | null
}

export function listCommand(): Command {
  return new Command('list')
    .alias('ls')
    .description('List worktrees for a repo')
    .argument('[repo]', 'registered repo name or alias')
    .option('--status', 'include dirty/ahead/merged status (slower)')
    .action(async (repoArg, options) => {
      await runList(repoArg, options)
    })
}

export async function gatherWorktrees(
  gitDir: string,
  withStatus: boolean,
): Promise<WorktreeReport[]> {
  const worktrees = await listWorktrees(gitDir)
  const base = withStatus
    ? await defaultBase(gitDir).catch(() => undefined)
    : undefined

  return Promise.all(
    worktrees.map(async (wt, index): Promise<WorktreeReport> => {
      const report: WorktreeReport = {
        path: wt.path,
        dir: basename(wt.path),
        branch: wt.branch ?? null,
        isMain: index === 0,
        dirty: false,
        upstream: null,
        ahead: 0,
        merged: false,
        parent: null,
      }
      if (!withStatus) return report

      report.dirty = await isDirty(wt.path)
      const upstream = await upstreamOf(wt.path)
      report.upstream = upstream ?? null
      if (upstream) report.ahead = await aheadCount(wt.path, upstream)
      if (wt.branch) {
        report.parent = (await stackParentOf(gitDir, wt.branch)) ?? null
        if (base) {
          report.merged = await isMergedInto(
            gitDir,
            `refs/heads/${wt.branch}`,
            base,
          )
        }
      }
      return report
    }),
  )
}

async function runList(
  repoArg: string | undefined,
  options: { status?: boolean },
): Promise<void> {
  const config = await loadConfig()
  const repoName = await pickRepo(config.reposFile, repoArg)
  const repo = await resolveRepo(config.reposFile, repoName)
  const gitDir = await gitDirFor(repo.path)

  const withStatus = options.status ?? getOutputContext().json
  const reports = await gatherWorktrees(gitDir, withStatus)

  if (getOutputContext().json) {
    emitJson({ ok: true, repo: repo.name, root: repo.path, worktrees: reports })
    return
  }

  if (reports.length === 0) {
    log('No worktrees found.')
    return
  }

  log()
  log(pc.bold(`Worktrees in ${repo.name}`))
  const width = Math.max(...reports.map((r) => r.dir.length))
  for (const report of reports) {
    const flags: string[] = []
    if (report.dirty) flags.push(pc.yellow('dirty'))
    if (report.ahead > 0) flags.push(pc.cyan(`↑${report.ahead}`))
    if (report.merged && !report.isMain) flags.push(pc.green('merged'))
    if (report.parent) flags.push(pc.magenta(`on ${report.parent}`))

    const name = report.dir.padEnd(width)
    const branch = report.branch ? pc.cyan(report.branch) : pc.dim('(detached)')
    const suffix = flags.length ? `  ${flags.join(' ')}` : ''
    log(`  ${name}  ${branch}${suffix}`)
  }
  log()
}
