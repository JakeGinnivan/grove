import { describe, it, expect } from 'vitest'
import {
  slugify,
  extractJiraKey,
  datePrefix,
  generateNames,
  stripJiraKey,
  worktreeDirForBranch,
  repoNameFromUrl,
} from '../src/core/naming.js'

describe('slugify', () => {
  it('lowercases and dashes words', () => {
    expect(slugify('Fix The Login Bug')).toBe('fix-the-login-bug')
  })

  it('strips punctuation', () => {
    expect(slugify('fix: login (again)!')).toBe('fix-login-again')
  })

  it('collapses repeated separators', () => {
    expect(slugify('a   --  b')).toBe('a-b')
  })

  it('trims leading and trailing dashes', () => {
    expect(slugify('  -hello-  ')).toBe('hello')
  })

  it('caps length at 50 characters without a trailing dash', () => {
    const result = slugify('a'.repeat(40) + ' ' + 'b'.repeat(40))
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result.endsWith('-')).toBe(false)
  })

  it('returns empty for input with no alphanumerics', () => {
    expect(slugify('!!! ???')).toBe('')
  })
})

describe('extractJiraKey', () => {
  it('finds a key in a sentence', () => {
    expect(extractJiraKey('fix ABC-123 please')).toBe('ABC-123')
  })

  it('uppercases lowercase input', () => {
    expect(extractJiraKey('abc-123')).toBe('ABC-123')
  })

  it('returns the first key when several are present', () => {
    expect(extractJiraKey('ABC-1 and DEF-2')).toBe('ABC-1')
  })

  it('handles keys containing digits', () => {
    expect(extractJiraKey('GRAPHYTE2-2469')).toBe('GRAPHYTE2-2469')
  })

  it('returns undefined when absent', () => {
    expect(extractJiraKey('no ticket here')).toBeUndefined()
  })

  it('does not match a bare number', () => {
    expect(extractJiraKey('123-456')).toBeUndefined()
  })
})

describe('datePrefix', () => {
  it('formats as yymmdd', () => {
    expect(datePrefix(new Date(2026, 7, 10))).toBe('260810')
  })

  it('zero-pads single digits', () => {
    expect(datePrefix(new Date(2026, 0, 5))).toBe('260105')
  })
})

describe('stripJiraKey', () => {
  it('removes the key and tidies separators', () => {
    expect(stripJiraKey('ABC-123: fix thing', 'ABC-123')).toBe('fix thing')
  })

  it('is case-insensitive', () => {
    expect(stripJiraKey('abc-123 fix', 'ABC-123')).toBe('fix')
  })

  it('leaves the title alone when no key given', () => {
    expect(stripJiraKey('fix thing')).toBe('fix thing')
  })
})

describe('generateNames', () => {
  const date = new Date(2026, 7, 10)

  it('builds branch and directory without a ticket', () => {
    const names = generateNames({
      title: 'fix login',
      branchPrefix: 'jake/',
      date,
    })
    expect(names.branch).toBe('jake/fix-login')
    expect(names.worktreeDir).toBe('260810-fix-login')
  })

  it('includes the ticket in both names', () => {
    const names = generateNames({
      title: 'fix login',
      jiraKey: 'ABC-123',
      branchPrefix: 'jake/',
      date,
    })
    expect(names.branch).toBe('jake/ABC-123-fix-login')
    expect(names.worktreeDir).toBe('260810-fix-login-ABC-123')
  })

  it('does not duplicate a ticket already in the title', () => {
    const names = generateNames({
      title: 'ABC-123 fix login',
      jiraKey: 'ABC-123',
      branchPrefix: 'jake/',
      date,
    })
    expect(names.branch).toBe('jake/ABC-123-fix-login')
    expect(names.slug).toBe('fix-login')
  })

  it('supports an empty branch prefix', () => {
    const names = generateNames({ title: 'fix', branchPrefix: '', date })
    expect(names.branch).toBe('fix')
  })

  it('throws when the title has no usable characters', () => {
    expect(() =>
      generateNames({ title: '!!!', branchPrefix: 'jake/', date }),
    ).toThrow(/at least one letter or number/)
  })
})

describe('worktreeDirForBranch', () => {
  const date = new Date(2026, 7, 10)

  it('drops the owner segment', () => {
    expect(worktreeDirForBranch('jake/fix-login', date)).toBe('260810-fix-login')
  })

  it('handles a branch with no owner', () => {
    expect(worktreeDirForBranch('main', date)).toBe('260810-main')
  })

  it('slugifies nested branch names', () => {
    expect(worktreeDirForBranch('feature/JIRA-1/thing', date)).toBe(
      '260810-jira-1thing',
    )
  })
})

describe('repoNameFromUrl', () => {
  it('handles scp-style ssh URLs', () => {
    expect(repoNameFromUrl('git@github.com:owner/my-repo.git')).toBe('my-repo')
  })

  it('handles https URLs', () => {
    expect(repoNameFromUrl('https://github.com/owner/my-repo.git')).toBe('my-repo')
  })

  it('handles URLs without the .git suffix', () => {
    expect(repoNameFromUrl('https://github.com/owner/my-repo')).toBe('my-repo')
  })

  it('handles trailing slashes', () => {
    expect(repoNameFromUrl('https://github.com/owner/my-repo/')).toBe('my-repo')
  })

  it('handles ssh:// URLs with a port', () => {
    expect(repoNameFromUrl('ssh://git@host:7999/proj/my-repo.git')).toBe('my-repo')
  })
})
