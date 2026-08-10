import { Command } from 'commander'
import pc from 'picocolors'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor, readRegistry } from '../core/registry.js'
import { git, defaultBase, isDirty, currentBranch } from '../core/git.js'
import { emitJson, log, success, warn, info, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'

/**
 * `wt sync` brings a repo's main worktree up to date. This is the command the
 * agent skills lean on before inspecting code, so it is fully non-interactive.
 */
export function syncCommand(): Command {
  return new Command('sync')
    .alias('pull')
    .description("Fetch and fast-forward a repo's main worktree")
    .argument('[repo]', 'registered repo name or alias (default: all repos)')
    .option('--all', 'sync every registered repo')
    .action(async (repoArg, options) => {
      await runSync(repoArg, options)
    })
}

interface SyncResult {
  repo: string
  path: string
  branch: string | null
  updated: boolean
  skipped: string | null
  from: string | null
  to: string | null
}

async function runSync(
  repoArg: string | undefined,
  options: { all?: boolean },
): Promise<void> {
  const config = await loadConfig()

  let names: string[]
  if (options.all || !repoArg) {
    const entries = await readRegistry(config.reposFile)
    names = entries.filter((entry) => !entry.aliasOf).map((entry) => entry.name)
    if (names.length === 0) {
      throw new WtError('No repos registered.', {
        code: 'no_repos',
        hint: 'Use `wt clone <url>` or `wt repos add <path>` first.',
      })
    }
    if (!options.all && repoArg === undefined && names.length > 1) {
      // Syncing everything is the sensible default for an agent with no args.
      info(`Syncing all ${names.length} registered repos...`)
    }
  } else {
    names = [repoArg]
  }

  const results: SyncResult[] = []
  for (const name of names) {
    results.push(await syncOne(config.reposFile, name))
  }

  if (getOutputContext().json) {
    emitJson({ ok: true, results })
    return
  }

  log()
  for (const result of results) {
    if (result.skipped) {
      warn(`${result.repo}: ${result.skipped}`)
    } else if (result.updated) {
      success(
        `${result.repo}: ${pc.dim(result.from?.slice(0, 8) ?? '')} → ${pc.green(
          result.to?.slice(0, 8) ?? '',
        )} on ${pc.cyan(result.branch ?? '?')}`,
      )
    } else {
      log(`  ${pc.dim('·')} ${result.repo}: already up to date`)
    }
  }
  log()
}

async function syncOne(reposFile: string, name: string): Promise<SyncResult> {
  const repo = await resolveRepo(reposFile, name)
  const gitDir = await gitDirFor(repo.path)
  const branch = await currentBranch(gitDir)

  const result: SyncResult = {
    repo: repo.name,
    path: gitDir,
    branch: branch ?? null,
    updated: false,
    skipped: null,
    from: null,
    to: null,
  }

  await git(['fetch', 'origin', '--prune'], { cwd: gitDir, allowFailure: true })

  // Only fast-forward when the main checkout is clean and on the default
  // branch; anything else risks clobbering in-progress work.
  if (await isDirty(gitDir)) {
    result.skipped = 'main worktree has uncommitted changes'
    return result
  }

  const base = await defaultBase(gitDir).catch(() => undefined)
  if (!base) {
    result.skipped = 'could not determine the default branch'
    return result
  }

  const expectedBranch = base.replace(/^origin\//, '')
  if (branch && branch !== expectedBranch) {
    result.skipped = `main worktree is on "${branch}", not "${expectedBranch}"`
    return result
  }

  const before = await git(['rev-parse', 'HEAD'], { cwd: gitDir })
  const merge = await git(['merge', '--ff-only', base], {
    cwd: gitDir,
    allowFailure: true,
  })
  if (merge.exitCode !== 0) {
    result.skipped = `fast-forward failed: ${merge.stderr.split('\n')[0] ?? ''}`
    return result
  }
  const after = await git(['rev-parse', 'HEAD'], { cwd: gitDir })

  result.from = before.stdout
  result.to = after.stdout
  result.updated = before.stdout !== after.stdout
  return result
}
