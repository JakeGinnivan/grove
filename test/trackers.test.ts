import { describe, it, expect } from 'vitest'
import {
  enabledTrackers,
  findIssue,
  parseIssue,
  describeFormats,
  parseTrackerList,
} from '../src/core/trackers.js'

describe('findIssue', () => {
  it('finds a Jira key in a title', () => {
    expect(findIssue('ABC-12 fix login', enabledTrackers(['jira']))).toEqual({
      tracker: 'jira',
      key: 'ABC-12',
    })
  })

  it('finds a GitHub number only when written with #', () => {
    const github = enabledTrackers(['github'])
    expect(findIssue('fix login (#42)', github)).toEqual({ tracker: 'github', key: '42' })
    expect(findIssue('bump node to 24', github)).toBeUndefined()
    expect(findIssue('escape &#39; entities', github)).toBeUndefined()
  })

  it('ignores trackers that are not enabled', () => {
    expect(findIssue('#42 fix', enabledTrackers(['jira']))).toBeUndefined()
    expect(findIssue('ABC-1 fix', enabledTrackers([]))).toBeUndefined()
  })

  it('picks the first enabled tracker that matches', () => {
    expect(findIssue('ABC-1 fix', enabledTrackers(['linear', 'jira']))?.tracker).toBe(
      'linear',
    )
  })
})

describe('parseIssue', () => {
  const both = enabledTrackers(['jira', 'github'])

  it('auto-detects the tracker from the key shape', () => {
    expect(parseIssue('abc-7', both)).toEqual({ tracker: 'jira', key: 'ABC-7' })
    expect(parseIssue('#7', both)).toEqual({ tracker: 'github', key: '7' })
    expect(parseIssue('7', both)).toEqual({ tracker: 'github', key: '7' })
  })

  it('reads keys out of issue URLs', () => {
    expect(parseIssue('https://acme.atlassian.net/browse/ABC-7', both)?.key).toBe('ABC-7')
    expect(parseIssue('https://github.com/o/r/issues/7', both)).toEqual({
      tracker: 'github',
      key: '7',
    })
  })

  it('rejects input no enabled tracker accepts', () => {
    expect(parseIssue('7', enabledTrackers(['jira']))).toBeUndefined()
  })
})

describe('describeFormats', () => {
  it('lists each key shape once', () => {
    expect(describeFormats(enabledTrackers(['jira', 'linear', 'github']))).toBe(
      'ABC-123 or #123',
    )
  })
})

describe('parseTrackerList', () => {
  it('parses a comma-separated list', () => {
    expect(parseTrackerList('GitHub, jira,github')).toEqual(['github', 'jira'])
  })

  it('treats none as an empty list', () => {
    expect(parseTrackerList('none')).toEqual([])
  })

  it('reports unknown trackers', () => {
    expect(parseTrackerList('jira,trello')).toMatch(/Unknown task tracker: trello/)
  })
})
