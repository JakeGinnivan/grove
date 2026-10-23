import { describe, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  runCli,
  runCliWithTty,
  gitIn,
} from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'
import { newWorktree, expectError, pushCommit } from './helpers/grove.js'

describe('wt new', () => {
  it('creates a worktree and branch from the default base', async ({ sandbox }) => {
    const data = await newWorktree(sandbox, 'fix login')
    expect(data.branch).toBe('test/fix-login')
    expect(data.base).toBe('origin/main')
    expect(existsSync(data.path)).toBe(true)
    expect(await gitIn(['rev-parse', '--abbrev-ref', 'HEAD'], data.path)).toBe(
      'test/fix-login',
    )
  })

  it('includes a Jira key in the branch and directory names', async ({ sandbox }) => {
    const data = await newWorktree(sandbox, 'fix login', '--jira', 'ABC-123')
    expect(data.branch).toBe('test/ABC-123-fix-login')
    expect(data.path).toMatch(/-fix-login-ABC-123$/)
  })

  it('infers a Jira key present in the title', async ({ sandbox }) => {
    const data = await newWorktree(sandbox, 'ABC-9 fix login')
    expect(data.branch).toBe('test/ABC-9-fix-login')
  })

  it('takes a GitHub issue number with --issue', async ({ sandbox }) => {
    const result = await runCli(
      ['new', 'demo', '--title', 'fix login', '--issue', '#42', '--json'],
      sandbox,
    )
    const data = result.json<{ path: string; branch: string; issue: unknown }>()
    expect(data.branch).toBe('test/42-fix-login')
    expect(data.path).toMatch(/-fix-login-42$/)
    expect(data.issue).toEqual({ tracker: 'github', key: '42' })
  })

  it('only infers keys for the configured task trackers', async ({ sandbox }) => {
    await runCli(['setup', '--task-trackers', 'github', '--json'], sandbox)
    const github = await runCli(['new', 'demo', '--title', 'fix #7 login', '--json'], sandbox)
    expect(github.json<{ branch: string }>().branch).toBe('test/7-fix-login')

    await runCli(['setup', '--task-trackers', 'none', '--json'], sandbox)
    const none = await runCli(['new', 'demo', '--title', 'ABC-9 other', '--json'], sandbox)
    expect(none.json<{ branch: string }>().branch).toBe('test/abc-9-other')
  })

  it('does not prompt for an issue key when no trackers are enabled', async ({ sandbox }) => {
    await runCli(['setup', '--task-trackers', 'none', '--json'], sandbox)
    const result = await runCliWithTty(
      ['new', 'demo', '--title', 'quiet'],
      sandbox,
      { GROVE_SHELL_INTEGRATION: '1' },
      { answerWhen: 'Create this worktree?' },
    )
    expect(result.stderr).not.toContain('key (optional)')
    expect(result.exitCode).toBe(0)
  })

  it('auto-detects the tracker from a key typed at the prompt', async ({ sandbox }) => {
    await runCli(['setup', '--task-trackers', 'jira,github', '--json'], sandbox)
    const result = await runCliWithTty(
      ['new', 'demo', '--title', 'typed key', '--yes'],
      sandbox,
      { GROVE_SHELL_INTEGRATION: '1' },
      { answerWhen: 'Issue key (optional)', keys: '#5\r' },
    )
    expect(result.stderr).toContain('ABC-123 or #123')
    expect(result.exitCode).toBe(0)
    const branch = await gitIn(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      result.stdout.trim().replace('__WT_CD__', ''),
    )
    expect(branch).toBe('test/5-typed-key')
  })

  it('fails with needs_input when the title is missing', async ({ sandbox }) => {
    const result = await runCli(['new', 'demo', '--json'], sandbox)
    expectError(result, 'needs_input')
  })

  it('refuses when the branch is already checked out elsewhere', async ({ sandbox }) => {
    await newWorktree(sandbox, 'dup')
    const second = await runCli(['new', 'demo', '--title', 'dup', '--dir', 'other', '--json'], sandbox)
    expectError(second, 'branch_in_use')
  })

  it('refuses to reuse a branch that exists but is not checked out', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'dup2')
    // Remove the worktree but keep the branch behind.
    await runCli(['cleanup', 'demo', path, '--yes', '--no-trash', '--json'], sandbox)

    const second = await runCli(['new', 'demo', '--title', 'dup2', '--json'], sandbox)
    expectError(second, 'branch_exists')
  })

  it('treats values after -- as literal, not as global flags', async ({ sandbox }) => {
    const result = await runCli(
      ['new', 'demo', '--json', '--', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    // The title was the literal string "--json", so the slug reflects it
    // rather than the command silently losing the argument.
    const data = result.json<{ branch: string }>()
    expect(data.branch).toBe('test/json')
  })

  it('reports unknown repos clearly', async ({ sandbox }) => {
    const result = await runCli(
      ['new', 'nope', '--title', 'x', '--json'],
      sandbox,
    )
    expectError(result, 'unknown_repo')
  })

  it('runs repo-defined setup commands in the new worktree', async ({ sandbox }) => {
    // Read from the repo root (the `main` checkout), which is where the file
    // is committed — not the parent directory, which is not version
    // controlled and so could never hold a committed config.
    await writeFile(
      join(sandbox.mainPath, 'worktree.json'),
      JSON.stringify({ 'setup-worktree': ['echo hi > setup-ran.txt'] }),
    )
    const data = await newWorktree(sandbox, 'with setup', '--setup')
    expect(existsSync(join(data.path, 'setup-ran.txt'))).toBe(true)
  })

  it('ignores a config in the worktree parent directory', async ({ sandbox }) => {
    await writeFile(
      join(sandbox.repoPath, 'worktree.json'),
      JSON.stringify({ 'setup-worktree': ['echo hi > setup-ran.txt'] }),
    )
    const data = await newWorktree(sandbox, 'parent config')
    expect(existsSync(join(data.path, 'setup-ran.txt'))).toBe(false)
  })

  it('does not run setup commands unless explicitly trusted', async ({ sandbox }) => {
    await writeFile(
      join(sandbox.mainPath, 'worktree.json'),
      JSON.stringify({ 'setup-worktree': ['echo hi > setup-ran.txt'] }),
    )
    const data = await newWorktree(sandbox, 'no setup')
    expect(existsSync(join(data.path, 'setup-ran.txt'))).toBe(false)
  })
})

describe('wt new --on (stacking)', () => {
  it('bases the branch on the parent worktree and records the parent', async ({ sandbox }) => {
    const base = await newWorktree(sandbox, 'base work')

    // Commit on the parent so the stack has something to build on.
    await writeFile(join(base.path, 'feature.txt'), 'work\n')
    await gitIn(['add', '.'], base.path)
    await gitIn(['commit', '-m', 'parent work'], base.path)
    const parentSha = await gitIn(['rev-parse', 'HEAD'], base.path)

    const stacked = await newWorktree(sandbox, 'follow up', '--on', base.branch)

    expect(stacked.parent).toBe(base.branch)
    expect(stacked.base).toBe(base.branch)
    // The stacked worktree starts at the parent's tip, so it sees its file.
    expect(await gitIn(['rev-parse', 'HEAD'], stacked.path)).toBe(parentSha)
    expect(existsSync(join(stacked.path, 'feature.txt'))).toBe(true)
  })

  it('accepts a worktree directory name for --on', async ({ sandbox }) => {
    const base = await newWorktree(sandbox, 'base work')
    const dirName = base.path.split('/').pop()!

    const second = await newWorktree(sandbox, 'follow up', '--on', dirName)
    expect(second.parent).toBe(base.branch)
  })

  it('surfaces the recorded parent in wt list', async ({ sandbox }) => {
    const base = await newWorktree(sandbox, 'base work')
    const stacked = await newWorktree(sandbox, 'follow up', '--on', base.branch)

    const list = await runCli(['list', 'demo', '--json'], sandbox)
    const data = list.json<{
      worktrees: { branch: string | null; parent: string | null }[]
    }>()
    const entry = data.worktrees.find((wt) => wt.branch === stacked.branch)
    expect(entry?.parent).toBe(base.branch)

    // Kept out of .git/config, which Claude Code's sandbox never lets a
    // command write.
    const gitDir = join(sandbox.mainPath, '.git')
    expect(await readFile(join(gitDir, 'config'), 'utf8')).not.toContain('wt-parent')
    expect(await readFile(join(gitDir, 'grove', 'config'), 'utf8')).toContain(base.branch)
  })

  it('forgets the parent when cleanup deletes the branch', async ({ sandbox }) => {
    const base = await newWorktree(sandbox, 'stack base')
    const top = await newWorktree(sandbox, 'stack top', '--on', base.branch)

    const removed = await runCli(
      ['cleanup', 'demo', top.path, '--yes', '--force', '--delete-branch', '--no-trash', '--json'],
      sandbox,
    )
    expect(removed.exitCode).toBe(0)
    const groveConfig = await readFile(join(sandbox.mainPath, '.git', 'grove', 'config'), 'utf8')
    expect(groveConfig).not.toContain(top.branch)
  })

  it('still reads a parent that older versions wrote to .git/config', async ({ sandbox }) => {
    const { branch } = await newWorktree(sandbox, 'legacy')
    await gitIn(['config', `branch.${branch}.wt-parent`, 'main'], sandbox.mainPath)

    const list = await runCli(['list', 'demo', '--json'], sandbox)
    const entry = list
      .json<{ worktrees: { branch: string | null; parent: string | null }[] }>()
      .worktrees.find((wt) => wt.branch === branch)
    expect(entry?.parent).toBe('main')
  })

  it('errors when --on cannot be resolved', async ({ sandbox }) => {
    const result = await runCli(['new', 'demo', '--title', 'x', '--on', 'no-such-thing', '--json'], sandbox)
    expectError(result, 'unknown_stack_parent')
  })
})

describe('wt checkout', () => {
  it('checks out an existing remote branch into a new worktree', async ({ sandbox }) => {
    // Publish a branch to the remote from an independent clone.
    await pushCommit(sandbox, { branch: 'colleague/feature', file: 'theirs.txt' })

    const result = await runCli(
      ['checkout', 'demo', 'colleague/feature', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{ path: string; branch: string; source: string }>()
    expect(data.source).toBe('remote')
    expect(existsSync(join(data.path, 'theirs.txt'))).toBe(true)
    expect(await gitIn(['rev-parse', '--abbrev-ref', 'HEAD'], data.path)).toBe(
      'colleague/feature',
    )
  })

  it('sets upstream tracking for a remote branch', async ({ sandbox }) => {
    await pushCommit(sandbox, { branch: 'tracked' })

    const result = await runCli(['checkout', 'demo', 'tracked', '--json'], sandbox)
    const data = result.json<{ path: string }>()
    const upstream = await gitIn(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      data.path,
    )
    expect(upstream).toBe('origin/tracked')
  })

  it('fails for an unknown branch without --create', async ({ sandbox }) => {
    const result = await runCli(['checkout', 'demo', 'ghost', '--json'], sandbox)
    expectError(result, 'branch_not_found')
  })

  it('creates the branch with --create', async ({ sandbox }) => {
    const result = await runCli(
      ['checkout', 'demo', 'brand-new', '--create', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{ path: string; created: boolean }>()
    expect(data.created).toBe(true)
    expect(await gitIn(['rev-parse', '--abbrev-ref', 'HEAD'], data.path)).toBe(
      'brand-new',
    )
  })

  it('returns the existing path when the branch is already checked out', async ({ sandbox }) => {
    const first = await runCli(
      ['checkout', 'demo', 'dup-branch', '--create', '--json'],
      sandbox,
    )
    const firstPath = first.json<{ path: string }>().path

    const second = await runCli(
      ['checkout', 'demo', 'dup-branch', '--json'],
      sandbox,
    )
    expect(second.exitCode).toBe(0)
    const data = second.json<{ path: string; created: boolean }>()
    expect(data.path).toBe(firstPath)
    expect(data.created).toBe(false)
  })

  it('needs a branch argument in non-interactive mode', async ({ sandbox }) => {
    const result = await runCli(['checkout', 'demo', '--json'], sandbox)
    expectError(result, 'needs_input')
  })

  it('lists the branches to choose from when none is given', async ({ sandbox }) => {
    // Publish a branch so the list has something beyond main to show.
    // Date the tip well ahead of main's. The picker sorts by commit date and
    // the fixture's commits otherwise share a timestamp to the second, which
    // would leave the order down to git's refname tiebreak.
    await pushCommit(sandbox, { branch: 'listed/branch', date: '2030-01-01T00:00:00Z' })

    const result = await runCliWithTty(
      ['checkout', 'demo'],
      sandbox,
      { GROVE_SHELL_INTEGRATION: '1' },
      { answerWhen: 'Enter: confirm' },
    )

    // The branch was offered in the prompt rather than typed by the user, and
    // accepting the highlighted entry checked it out. It is the most recent
    // commit in the repo, so it heads the list.
    expect(result.stderr).toContain('Which branch?')
    expect(result.stderr).toContain('listed/branch')
    expect(result.exitCode).toBe(0)

    const branch = await gitIn(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      result.stdout.trim().replace('__WT_CD__', ''),
    )
    expect(branch).toBe('listed/branch')
  })

  it('marks a branch that is already checked out in the picker', async ({ sandbox }) => {
    await newWorktree(sandbox, 'taken branch')

    const result = await runCliWithTty(
      ['checkout', 'demo'],
      sandbox,
      { GROVE_SHELL_INTEGRATION: '1' },
      { answerWhen: 'Enter: confirm' },
    )

    expect(result.stderr).toContain('test/taken-branch')
    expect(result.stderr).toContain('already checked out')
  })

  it('still prompts for a free-text name with --create', async ({ sandbox }) => {
    // Nothing to list for a branch that does not exist yet, so --create keeps
    // the text prompt and its placeholder rather than showing a picker.
    const result = await runCliWithTty(
      ['checkout', 'demo', '--create'],
      sandbox,
      { GROVE_SHELL_INTEGRATION: '1' },
      { answerWhen: 'feature/some-branch' },
    )
    expect(result.stderr).toContain('feature/some-branch')
  })
})
