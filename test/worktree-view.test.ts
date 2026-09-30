import { describe, it, expect } from 'vitest'
import {
  arrange,
  flatten,
  describeStatus,
  isSafeToRemove,
  matchWorktree,
  type WorktreeReport,
} from '../src/core/worktree-view.js'

function report(dir: string, status: Partial<WorktreeReport> = {}): WorktreeReport {
  return {
    path: `/repo/${dir}`,
    dir,
    branch: dir,
    isMain: false,
    committedAt: 0,
    dirty: false,
    upstream: `origin/${dir}`,
    ahead: 0,
    merged: false,
    base: 'origin/main',
    behindBase: null,
    parent: null,
    ...status,
  }
}

const dirs = (reports: WorktreeReport[]) => reports.map((r) => r.dir)

describe('arrange', () => {
  const main = report('main', { isMain: true, committedAt: 1 })

  it('pins main on top and sorts the rest newest first', () => {
    const arranged = arrange(
      [main, report('old', { committedAt: 10 }), report('new', { committedAt: 20 })],
      { sort: 'recent', group: 'none' },
    )
    expect(dirs(flatten(arranged))).toEqual(['main', 'new', 'old'])
  })

  it('sorts by name when asked', () => {
    const arranged = arrange(
      [main, report('b', { committedAt: 20 }), report('a', { committedAt: 10 })],
      { sort: 'name', group: 'none' },
    )
    expect(dirs(flatten(arranged))).toEqual(['main', 'a', 'b'])
  })

  it('groups by how safe removal is, newest first within each group', () => {
    const { groups } = arrange(
      [
        report('dirty', { dirty: true, committedAt: 30 }),
        report('clean'),
        report('fresh', { merged: true, behindBase: 0 }),
        report('merged-old', { merged: true, committedAt: 10 }),
        report('merged-new', { merged: true, committedAt: 20 }),
      ],
      { sort: 'recent', group: 'status' },
    )
    expect(groups.map((g) => [g.title, dirs(g.reports)])).toEqual([
      ['Merged', ['merged-new', 'merged-old']],
      ['No commits of its own', ['fresh']],
      ['Clean, not merged', ['clean']],
      ['Uncommitted changes', ['dirty']],
    ])
  })

  it('puts a merged worktree with uncommitted changes with the dirty ones', () => {
    const { groups } = arrange([report('wip', { merged: true, dirty: true })], {
      sort: 'recent',
      group: 'status',
    })
    expect(groups.map((g) => g.title)).toEqual(['Uncommitted changes'])
  })

  it('omits empty groups', () => {
    const { groups } = arrange([report('clean')], { sort: 'recent', group: 'status' })
    expect(groups.map((g) => g.title)).toEqual(['Clean, not merged'])
  })
})

describe('describeStatus', () => {
  it('reports push state', () => {
    expect(describeStatus(report('a'))).toBe('○ clean, pushed')
    expect(describeStatus(report('a', { ahead: 2 }))).toBe('○ clean, 2 unpushed')
    expect(describeStatus(report('a', { upstream: null }))).toBe('○ clean, not pushed')
  })

  it('does not call main merged', () => {
    expect(describeStatus(report('main', { isMain: true, merged: true }))).toBe(
      '○ clean, pushed',
    )
  })

  it('shows a branch with no commits of its own against base, not as merged', () => {
    const fresh = { merged: true, upstream: null }
    expect(describeStatus(report('a', { ...fresh, behindBase: 0 }))).toBe(
      '○ clean, = origin/main',
    )
    expect(describeStatus(report('a', { ...fresh, behindBase: 3 }))).toBe(
      '○ clean, 3 behind origin/main',
    )
  })

  it('shows main behind origin', () => {
    const main = report('main', { isMain: true, merged: true, behindBase: 2 })
    expect(describeStatus(main)).toBe('○ clean, 2 behind origin/main, pushed')
  })
})

describe('isSafeToRemove', () => {
  it('covers merged branches and branches with no commits of their own', () => {
    expect(isSafeToRemove(report('a', { merged: true }))).toBe(true)
    expect(isSafeToRemove(report('a', { merged: true, behindBase: 0 }))).toBe(true)
    expect(isSafeToRemove(report('a', { merged: true, behindBase: 0, dirty: true }))).toBe(false)
    expect(isSafeToRemove(report('a'))).toBe(false)
  })
})

describe('matchWorktree', () => {
  const reports = [report('260101-alpha'), report('260102-beta')]

  it('falls back to a unique substring only when partial', () => {
    expect(matchWorktree(reports, 'alpha', { partial: true }).dir).toBe('260101-alpha')
    expect(() => matchWorktree(reports, 'alpha', { partial: false })).toThrow(
      'No worktree matching',
    )
  })

  it('refuses an ambiguous substring', () => {
    expect(() => matchWorktree(reports, '2601', { partial: true })).toThrow('matches 2')
  })
})
