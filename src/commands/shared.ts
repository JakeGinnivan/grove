import { readRegistry } from '../core/registry.js'
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

  return select(
    'Which repo?',
    canonical.map((entry) => ({
      value: entry.name,
      label: entry.name,
      hint: entry.path,
    })),
    'A repo name',
  )
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
