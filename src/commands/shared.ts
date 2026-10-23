import { readRegistry, gitDirFor, type RepoEntry } from '../core/registry.js'
import { listWorktrees } from '../core/git.js'
import { select, canPrompt } from '../core/prompts.js'
import { WtError, NeedsInputError } from '../core/errors.js'
import {
  profileList,
  getProfile,
  type GroveConfig,
  type ResolvedProfile,
} from '../core/config.js'
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

/**
 * Decide which profile a new repo belongs to, for `clone` and `create` alike:
 * --profile wins, then the only profile, then the configured default, then a
 * prompt when several exist and we can ask.
 */
export async function chooseProfile(
  config: GroveConfig,
  requested: string | undefined,
): Promise<ResolvedProfile | undefined> {
  if (requested) return getProfile(config, requested)

  const profiles = profileList(config)
  if (profiles.length === 0) return undefined
  if (profiles.length === 1) return profiles[0]

  if (config.defaultProfile) {
    return getProfile(config, config.defaultProfile)
  }

  if (!canPrompt()) {
    throw new NeedsInputError(
      `A profile is required (${profiles.length} configured, no default set)`,
      `--profile <${profiles.map((p) => p.name).join('|')}>`,
    )
  }

  const chosen = await select(
    'Which profile should this repo live in?',
    profiles.map((profile) => ({
      value: profile.name,
      label: profile.name,
      hint: profile.description ?? profile.dir,
    })),
    'A profile name',
  )
  return getProfile(config, chosen)
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
