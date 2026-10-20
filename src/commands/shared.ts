import { readRegistry, gitDirFor, type RepoEntry } from '../core/registry.js'
import { listWorktrees } from '../core/git.js'
import { select } from '../core/prompts.js'
import { WtError } from '../core/errors.js'
import { Command, Option } from 'commander'
import type { ViewOptions } from '../core/worktree-view.js'

/**
 * Resolve the repo argument, prompting when omitted. Errors clearly in
 * non-interactive mode so agents get an actionable message.
 */
export async function pickRepo(
  reposFile: string,
  provided: string | undefined,
  { worktreeCounts = false }: { worktreeCounts?: boolean } = {},
): Promise<string> {
  if (provided) return provided

  const entries = await readRegistry(reposFile)
  const canonical = entries.filter((entry) => !entry.aliasOf)
  if (canonical.length === 0) {
    throw new WtError('No repos registered.', {
      code: 'no_repos',
      hint: 'Use `wt clone <url>` or `wt import <path>` first.',
    })
  }
  if (canonical.length === 1) return canonical[0]!.name

  const counts = worktreeCounts
    ? await Promise.all(canonical.map(countWorktrees))
    : canonical.map(() => undefined)
  return select(
    'Which repo?',
    canonical.map((entry, index) => {
      const count = counts[index]
      return {
        value: entry.name,
        label: count === undefined ? entry.name : `${entry.name} (${count})`,
        hint: entry.path,
      }
    }),
    'A repo name',
  )
}

/** Worktrees besides the main checkout, or undefined when git can't say. */
async function countWorktrees(entry: RepoEntry): Promise<number | undefined> {
  try {
    const worktrees = await listWorktrees(await gitDirFor(entry.path))
    return Math.max(worktrees.length - 1, 0)
  } catch {
    return undefined
  }
}

/** The `--sort` and `--group` flags every worktree view shares. */
export function withViewOptions(command: Command, defaults: ViewOptions): Command {
  return command
    .addOption(
      new Option('--sort <order>', 'order within each group')
        .choices(['recent', 'name'])
        .default(defaults.sort),
    )
    .addOption(
      new Option('--group <by>', 'group by status, or not at all')
        .choices(['status', 'none'])
        .default(defaults.group),
    )
}
