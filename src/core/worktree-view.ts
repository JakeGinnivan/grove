import { basename } from 'node:path'
import { styleText } from 'node:util'
import { samePath } from './paths.js'
import { WtError } from './errors.js'
import {
  listWorktrees,
  commitTimes,
  isDirty,
  upstreamOf,
  aheadCount,
  defaultBase,
  isMergedInto,
  behindOnMainline,
} from './git.js'
import { stackParentOf } from './worktree.js'

/**
 * One worktree as `list`, `pick` and `cleanup` all see it. Loading, ordering,
 * rendering and matching live here so the three commands differ only in what
 * they do with the result.
 */
export interface WorktreeReport {
  path: string
  dir: string
  branch: string | null
  isMain: boolean
  /** Committer time (unix seconds) of HEAD, or null for an unborn branch. */
  committedAt: number | null
  dirty: boolean
  upstream: string | null
  ahead: number
  /** Contained in `base`, including a branch with no commits of its own. */
  merged: boolean
  /** The default branch status is compared against, e.g. `origin/main`. */
  base: string | null
  /**
   * Set when the branch has no commits of its own: how far `base` has moved
   * on since (0 means the same commit). Null when it has its own commits.
   */
  behindBase: number | null
  parent: string | null
}

export type SortOrder = 'recent' | 'name'
export type Grouping = 'status' | 'none'

export interface ViewOptions {
  sort: SortOrder
  group: Grouping
}

export interface WorktreeGroup {
  /** Null when the view is not grouped. */
  title: string | null
  reports: WorktreeReport[]
}

export interface Arranged {
  main: WorktreeReport | undefined
  groups: WorktreeGroup[]
}

/**
 * Load every worktree. git lists the primary checkout first, which is how
 * `isMain` is decided. Without `status`, only the cheap fields are filled.
 */
export async function loadWorktrees(
  gitDir: string,
  { status }: { status: boolean },
): Promise<WorktreeReport[]> {
  const worktrees = await listWorktrees(gitDir)
  const [times, base] = await Promise.all([
    commitTimes(
      gitDir,
      worktrees.flatMap((wt) => (wt.head ? [wt.head] : [])),
    ),
    status ? defaultBase(gitDir).catch(() => undefined) : undefined,
  ])

  return Promise.all(
    worktrees.map(async (wt, index): Promise<WorktreeReport> => {
      const report: WorktreeReport = {
        path: wt.path,
        dir: basename(wt.path),
        branch: wt.branch ?? null,
        isMain: index === 0,
        committedAt: (wt.head && times.get(wt.head)) || null,
        dirty: false,
        upstream: null,
        ahead: 0,
        merged: false,
        base: base ?? null,
        behindBase: null,
        parent: null,
      }
      if (!status) return report

      report.dirty = await isDirty(wt.path)
      report.upstream = (await upstreamOf(wt.path)) ?? null
      if (report.upstream) report.ahead = await aheadCount(wt.path, report.upstream)
      if (wt.branch) {
        report.parent = (await stackParentOf(gitDir, wt.branch)) ?? null
        if (base) {
          report.merged = await isMergedInto(gitDir, `refs/heads/${wt.branch}`, base)
        }
      }
      if (base && wt.head && report.merged) {
        report.behindBase = (await behindOnMainline(gitDir, wt.head, base)) ?? null
      }
      return report
    }),
  )
}

const STATUS_GROUPS = [
  'Merged',
  'No commits of its own',
  'Clean, not merged',
  'Uncommitted changes',
] as const

/**
 * Bucket by how safe a worktree is to remove: merged-and-clean ones lose
 * nothing, and anything with local changes lands last so it is never picked
 * by accident.
 */
function statusGroup(report: WorktreeReport): (typeof STATUS_GROUPS)[number] {
  if (report.dirty) return 'Uncommitted changes'
  if (report.behindBase !== null) return 'No commits of its own'
  if (report.merged) return 'Merged'
  return 'Clean, not merged'
}

/** Main split out to sit on top, the rest grouped then sorted. */
export function arrange(reports: WorktreeReport[], options: ViewOptions): Arranged {
  const main = reports.find((report) => report.isMain)
  const rest = reports.filter((report) => !report.isMain)
  const sorted =
    options.sort === 'name'
      ? rest.sort((a, b) => a.dir.localeCompare(b.dir))
      : // Stable, so equal times keep git's order.
        rest.sort((a, b) => (b.committedAt ?? 0) - (a.committedAt ?? 0))

  if (options.group === 'none') {
    return { main, groups: sorted.length ? [{ title: null, reports: sorted }] : [] }
  }
  const groups = STATUS_GROUPS.map((title) => ({
    title,
    reports: sorted.filter((report) => statusGroup(report) === title),
  }))
  return { main, groups: groups.filter((group) => group.reports.length > 0) }
}

/** Main first, then every group in order. */
export function flatten({ main, groups }: Arranged): WorktreeReport[] {
  return [...(main ? [main] : []), ...groups.flatMap((group) => group.reports)]
}

/** Removing it loses nothing, so cleanup preselects it. */
export function isSafeToRemove(report: WorktreeReport): boolean {
  return report.merged && !report.dirty
}

type Color = Parameters<typeof styleText>[0]

/** Status tags for a report, most important first. */
function statusTags(report: WorktreeReport): { text: string; color: Color }[] {
  // The main checkout always counts as merged into its own upstream, and a
  // branch with no commits of its own was never really merged.
  const merged = report.merged && !report.isMain && report.behindBase === null
  const tags: { text: string; color: Color }[] = [
    report.dirty
      ? { text: '● uncommitted changes', color: 'yellow' }
      : { text: '○ clean', color: 'green' },
  ]
  if (merged) tags.push({ text: '✔ merged', color: 'green' })
  if (report.behindBase === 0) tags.push({ text: `= ${report.base}`, color: 'green' })
  if (report.behindBase) {
    tags.push({ text: `${report.behindBase} behind ${report.base}`, color: 'cyan' })
  }
  if (report.ahead > 0) tags.push({ text: `${report.ahead} unpushed`, color: 'yellow' })
  else if (report.upstream && !merged) tags.push({ text: 'pushed', color: 'gray' })
  // Nothing to push when every commit is already in base.
  if (!report.upstream && !report.merged) tags.push({ text: 'not pushed', color: 'gray' })
  if (report.parent) tags.push({ text: `on ${report.parent}`, color: 'magenta' })
  return tags
}

/** Status as plain text, for messages that are not a list row. */
export function describeStatus(report: WorktreeReport): string {
  return statusTags(report).map((tag) => tag.text).join(', ')
}

export interface RowWidths {
  dir: number
  /** Plain-text width of the status tags; 0 when status is not shown. */
  status: number
}

const TAG_GAP = '  '

/** Column widths that line every row up. */
export function rowWidths(reports: WorktreeReport[], { status }: { status: boolean }): RowWidths {
  const plain = (report: WorktreeReport) =>
    statusTags(report).map((tag) => tag.text).join(TAG_GAP).length
  return {
    dir: Math.max(0, ...reports.map((report) => report.dir.length)),
    status: status ? Math.max(0, ...reports.map(plain)) : 0,
  }
}

/**
 * One row: the directory, then status tags, each padded to `widths`. clack
 * only shows an option's hint on the row under the cursor, so status goes in
 * the label itself to be scannable down the whole list. Styled against stderr
 * because that is where prompts and `log` render; stdout is often the shell
 * wrapper's pipe and would report no colour support.
 */
export function rowLabel(report: WorktreeReport, widths: RowWidths): string {
  const dir = report.dir.padEnd(widths.dir)
  if (widths.status === 0) return dir
  const tags = statusTags(report)
  const length = tags.map((tag) => tag.text).join(TAG_GAP).length
  const styled = tags
    .map((tag) => styleText(tag.color, tag.text, { stream: process.stderr }))
    .join(TAG_GAP)
  return `${dir}  ${styled}${' '.repeat(widths.status - length)}`
}

/**
 * Find a worktree by directory name, branch or path. With `partial`, a query
 * that matches none of those exactly may still match a single worktree by
 * substring.
 */
export function matchWorktree(
  reports: WorktreeReport[],
  query: string,
  { partial }: { partial: boolean },
): WorktreeReport {
  const exact = reports.find(
    (report) =>
      report.dir === query || report.branch === query || samePath(report.path, query),
  )
  if (exact) return exact

  const matches = partial
    ? reports.filter(
        (report) => report.dir.includes(query) || (report.branch?.includes(query) ?? false),
      )
    : []
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new WtError(`"${query}" matches ${matches.length} worktrees.`, {
      code: 'ambiguous_worktree',
      hint: `Matches: ${matches.map((report) => report.dir).join(', ')}`,
    })
  }
  throw new WtError(`No worktree matching "${query}".`, {
    code: 'no_matching_worktree',
    hint: `Available: ${reports.map((report) => report.dir).join(', ')}`,
  })
}
