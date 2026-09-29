import { describe, it, expect } from 'vitest'
import { groupCandidates } from '../src/commands/cleanup.js'
import type { WorktreeReport } from '../src/commands/list.js'

function report(dir: string, status: Partial<WorktreeReport> = {}): WorktreeReport {
  return {
    path: `/repo/${dir}`,
    dir,
    branch: dir,
    isMain: false,
    dirty: false,
    upstream: `origin/${dir}`,
    ahead: 0,
    merged: false,
    parent: null,
    ...status,
  }
}

describe('groupCandidates', () => {
  it('buckets merged, clean and dirty worktrees in that order', () => {
    const groups = groupCandidates([
      report('dirty', { dirty: true }),
      report('clean'),
      report('merged', { merged: true }),
    ])
    expect(groups.map((g) => [g.title, g.reports.map((r) => r.dir), g.preselect])).toEqual([
      ['Merged', ['merged'], true],
      ['Clean, not merged', ['clean'], false],
      ['Uncommitted changes', ['dirty'], false],
    ])
  })

  it('does not preselect a merged worktree with uncommitted changes', () => {
    const groups = groupCandidates([report('wip', { merged: true, dirty: true })])
    expect(groups).toEqual([
      { title: 'Uncommitted changes', reports: [expect.objectContaining({ dir: 'wip' })], preselect: false },
    ])
  })

  it('omits empty groups', () => {
    expect(groupCandidates([report('clean')]).map((g) => g.title)).toEqual(['Clean, not merged'])
  })
})
