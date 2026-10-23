import { describe, it, expect } from 'vitest'
import {
  slugify,
  extractJiraKey,
  datePrefix,
  generateNames,
  stripIssueKey,
  worktreeDirForBranch,
  repoNameFromUrl,
} from '../src/core/naming.js'

describe('slugify', () => {
  it.each([
    ['lowercases and dashes words', 'Fix The Login Bug', 'fix-the-login-bug'],
    ['strips punctuation', 'fix: login (again)!', 'fix-login-again'],
    ['collapses repeated separators', 'a   --  b', 'a-b'],
    ['trims leading and trailing dashes', '  -hello-  ', 'hello'],
    ['returns empty with no alphanumerics', '!!! ???', ''],
  ])('%s', (_, input, expected) => {
    expect(slugify(input)).toBe(expected)
  })

  it('caps length at 50 characters without a trailing dash', () => {
    const result = slugify('a'.repeat(40) + ' ' + 'b'.repeat(40))
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result.endsWith('-')).toBe(false)
  })
})

describe('extractJiraKey', () => {
  it.each([
    ['finds a key in a sentence', 'fix ABC-123 please', 'ABC-123'],
    ['uppercases lowercase input', 'abc-123', 'ABC-123'],
    ['returns the first of several keys', 'ABC-1 and DEF-2', 'ABC-1'],
    ['handles keys containing digits', 'GRAPHYTE2-2469', 'GRAPHYTE2-2469'],
    ['returns undefined when absent', 'no ticket here', undefined],
    ['does not match a bare number', '123-456', undefined],
  ])('%s', (_, input, expected) => {
    expect(extractJiraKey(input)).toBe(expected)
  })
})

describe('datePrefix', () => {
  it.each([
    ['formats as yymmdd', new Date(2026, 7, 10), '260810'],
    ['zero-pads single digits', new Date(2026, 0, 5), '260105'],
  ])('%s', (_, date, expected) => {
    expect(datePrefix(date)).toBe(expected)
  })
})

describe('stripIssueKey', () => {
  it.each([
    ['removes the key and tidies separators', 'ABC-123: fix thing', 'ABC-123', 'fix thing'],
    ['is case-insensitive', 'abc-123 fix', 'ABC-123', 'fix'],
    ['leaves the title alone when no key given', 'fix thing', undefined, 'fix thing'],
    ['removes a GitHub number only with its #', '#24 bump node to 24', '24', 'bump node to 24'],
  ])('%s', (_, title, key, expected) => {
    expect(stripIssueKey(title, key)).toBe(expected)
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
      issueKey: 'ABC-123',
      branchPrefix: 'jake/',
      date,
    })
    expect(names.branch).toBe('jake/ABC-123-fix-login')
    expect(names.worktreeDir).toBe('260810-fix-login-ABC-123')
  })

  it('does not duplicate a ticket already in the title', () => {
    const names = generateNames({
      title: 'ABC-123 fix login',
      issueKey: 'ABC-123',
      branchPrefix: 'jake/',
      date,
    })
    expect(names.branch).toBe('jake/ABC-123-fix-login')
    expect(names.slug).toBe('fix-login')
  })

  it('puts a GitHub issue number in both names', () => {
    const names = generateNames({
      title: 'fix login #42',
      issueKey: '42',
      branchPrefix: 'jake/',
      date,
    })
    expect(names.branch).toBe('jake/42-fix-login')
    expect(names.worktreeDir).toBe('260810-fix-login-42')
    expect(names.workspaceTitle).toBe('#42 • fix login #42')
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

  it.each([
    ['drops the owner segment', 'jake/fix-login', '260810-fix-login'],
    ['handles a branch with no owner', 'main', '260810-main'],
    ['slugifies nested branch names', 'feature/JIRA-1/thing', '260810-jira-1thing'],
  ])('%s', (_, branch, expected) => {
    expect(worktreeDirForBranch(branch, date)).toBe(expected)
  })
})

describe('repoNameFromUrl', () => {
  // A Windows drive letter ends in a colon, so splitting on ':' alone would
  // cut at `C:` and return the rest of the path as the name.
  it.each([
    ['scp-style ssh URLs', 'git@github.com:owner/my-repo.git'],
    ['https URLs', 'https://github.com/owner/my-repo.git'],
    ['URLs without the .git suffix', 'https://github.com/owner/my-repo'],
    ['trailing slashes', 'https://github.com/owner/my-repo/'],
    ['ssh:// URLs with a port', 'ssh://git@host:7999/proj/my-repo.git'],
    ['POSIX filesystem paths', '/srv/git/my-repo.git'],
    ['Windows paths with a drive letter', 'C:\\repos\\my-repo.git'],
    ['Windows UNC paths', '\\\\server\\share\\my-repo.git'],
    ['Windows paths with a trailing separator', 'C:\\repos\\my-repo\\'],
  ])('handles %s', (_, url) => {
    expect(repoNameFromUrl(url)).toBe('my-repo')
  })
})
