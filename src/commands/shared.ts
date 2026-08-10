import { readRegistry } from '../core/registry.js'
import { select } from '../core/prompts.js'
import { WtError } from '../core/errors.js'
import { basename } from 'node:path'
import type { Worktree } from '../core/git.js'

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
      hint: 'Use `wt clone <url>` or `wt register <path>` first.',
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

/** Label a worktree for display in a picker. */
export function worktreeLabel(worktree: Worktree): string {
  return basename(worktree.path)
}

export function worktreeHint(worktree: Worktree): string {
  if (worktree.branch) return worktree.branch
  if (worktree.detached) return `detached @ ${worktree.head?.slice(0, 8) ?? '?'}`
  return worktree.path
}
