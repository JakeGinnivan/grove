import { Command } from 'commander'
import { samePath } from '../core/paths.js'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor } from '../core/registry.js'
import { listWorktrees } from '../core/git.js'
import { select } from '../core/prompts.js'
import { emitJson, emitCd, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'
import { pickRepo, worktreeLabel, worktreeHint } from './shared.js'

export function pickCommand(): Command {
  return new Command('pick')
    .alias('cd')
    .description('Select a worktree and cd into it')
    .argument('[repo]', 'registered repo name or alias')
    .argument('[query]', 'directory or branch to match; skips the picker')
    .option('--main', 'jump straight to the main worktree')
    .option('--path-only', 'print the path without the cd sentinel')
    .action(async (repoArg, queryArg, options) => {
      await runPick(repoArg, queryArg, options)
    })
}

async function runPick(
  repoArg: string | undefined,
  queryArg: string | undefined,
  options: { main?: boolean; pathOnly?: boolean },
): Promise<void> {
  const config = await loadConfig()
  const repoName = await pickRepo(config.reposFile, repoArg)
  const repo = await resolveRepo(config.reposFile, repoName)
  const gitDir = await gitDirFor(repo.path)
  const worktrees = await listWorktrees(gitDir)

  if (worktrees.length === 0) {
    throw new WtError('No worktrees found.', { code: 'no_worktrees' })
  }

  let chosen: string
  if (options.main) {
    // Prefer git's own record so the reported path and branch stay
    // consistent with every other command.
    chosen = worktrees.find((wt) => samePath(wt.path, gitDir))?.path ?? gitDir
  } else if (queryArg) {
    const match = worktrees.find(
      (wt) =>
        worktreeLabel(wt) === queryArg ||
        wt.branch === queryArg ||
        samePath(wt.path, queryArg),
    )
    if (!match) {
      // Fall back to a unique substring match before giving up.
      const partial = worktrees.filter(
        (wt) =>
          worktreeLabel(wt).includes(queryArg) ||
          (wt.branch?.includes(queryArg) ?? false),
      )
      if (partial.length === 1) {
        chosen = partial[0]!.path
      } else if (partial.length > 1) {
        throw new WtError(`"${queryArg}" matches ${partial.length} worktrees.`, {
          code: 'ambiguous_worktree',
          hint: `Matches: ${partial.map(worktreeLabel).join(', ')}`,
        })
      } else {
        throw new WtError(`No worktree matching "${queryArg}".`, {
          code: 'no_matching_worktree',
        })
      }
    } else {
      chosen = match.path
    }
  } else {
    chosen = await select(
      `Worktree in ${repo.name}`,
      worktrees.map((wt) => ({
        value: wt.path,
        label: worktreeLabel(wt),
        hint: worktreeHint(wt),
      })),
      'A worktree',
    )
  }

  if (getOutputContext().json) {
    const match = worktrees.find((wt) => samePath(wt.path, chosen))
    emitJson({
      ok: true,
      repo: repo.name,
      path: chosen,
      branch: match?.branch ?? null,
    })
    return
  }

  if (options.pathOnly) {
    process.stdout.write(`${chosen}\n`)
    return
  }
  emitCd(chosen)
}
