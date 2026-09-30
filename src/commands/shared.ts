import { readRegistry } from '../core/registry.js'
import { select } from '../core/prompts.js'
import { WtError } from '../core/errors.js'
import { basename } from 'node:path'
import { styleText } from 'node:util'
import type { Worktree } from '../core/git.js'
import type { WorktreeReport } from './list.js'

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

/** Label a worktree for display in a picker. */
export function worktreeLabel(worktree: Worktree): string {
  return basename(worktree.path)
}

/**
 * clack only shows an option's hint on the row under the cursor, so status
 * goes in the label itself to be scannable down the whole list. Styled
 * against stderr because that is where prompts render; stdout is often the
 * shell wrapper's pipe and would report no colour support.
 */
export function statusLabel(report: WorktreeReport, width: number): string {
  const paint = (format: Parameters<typeof styleText>[0], text: string) =>
    styleText(format, text, { stream: process.stderr })
  // The main checkout always counts as merged into its own upstream.
  const merged = report.merged && !report.isMain
  const tags: string[] = [
    report.dirty
      ? paint('yellow', '● uncommitted changes')
      : paint('green', '○ clean'),
  ]
  if (merged) tags.push(paint('green', '✔ merged'))
  if (report.ahead > 0) tags.push(paint('yellow', `${report.ahead} unpushed`))
  if (!report.upstream && !merged) tags.push(paint('gray', 'no upstream'))
  return `${report.dir.padEnd(width)}  ${tags.join('  ')}`
}
