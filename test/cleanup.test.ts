import { describe, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import {
  runCli,
  runCliWithTty,
  gitIn,
  type Sandbox,
} from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'
import { newWorktree, expectError } from './helpers/grove.js'

describe('wt cleanup', () => {
  it('removes a clean worktree', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'disposable')

    const result = await runCli(
      ['cleanup', 'demo', path, '--yes', '--no-trash', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{ removed: { path: string }[]; skipped: unknown[] }>()
    expect(data.removed).toHaveLength(1)
    expect(data.skipped).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  it('removes a worktree whose upstream branch was deleted on merge', async ({ sandbox }) => {
    // The delete-branch-on-merge flow: push the branch, merge and delete it
    // upstream, then prune. `branch.<name>.merge` still names the gone ref, so
    // `rev-parse @{u}` exits non-zero *and* echoes the literal "@{u}" on
    // stdout. Reading stdout without the exit code hands that back as a ref
    // name, and `rev-list @{u}..HEAD` then fails the whole command.
    const { path, branch } = await newWorktree(sandbox, 'merged upstream')
    await gitIn(['push', '-u', 'origin', branch], path)
    await gitIn(['push', 'origin', '--delete', branch], path)
    await gitIn(['fetch', '--prune'], path)

    // Guard the setup: without a stale upstream config there is no bug to hit.
    expect(await gitIn(['config', '--get', `branch.${branch}.merge`], path)).toBe(
      `refs/heads/${branch}`,
    )

    const listed = await runCli(['list', 'demo', '--json'], sandbox)
    expect(listed.exitCode).toBe(0)
    const entry = listed
      .json<{ worktrees: { path: string; upstream: string | null }[] }>()
      .worktrees.find((wt) => wt.path === path)
    expect(entry?.upstream).toBeNull()

    const result = await runCli(
      ['cleanup', 'demo', path, '--yes', '--no-trash', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    expect(existsSync(path)).toBe(false)
  })

  it('requires --yes before non-interactive removal', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'needs consent')

    const result = await runCli(
      ['cleanup', 'demo', path, '--no-trash', '--json'],
      sandbox,
    )
    expectError(result, 'needs_input')
    expect(existsSync(path)).toBe(true)
  })

  it('skips a dirty worktree under --yes, and removes it with --force', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'has work')
    await writeFile(join(path, 'wip.txt'), 'important\n')

    const skipped = await runCli(
      ['cleanup', 'demo', path, '--yes', '--no-trash', '--json'],
      sandbox,
    )
    const data = skipped.json<{ removed: unknown[]; skipped: { reason: string }[] }>()
    // A skipped worktree must not be listed under `removed`.
    expect(data.removed).toEqual([])
    expect(data.skipped[0]?.reason).toMatch(/--force/)
    expect(existsSync(path)).toBe(true)

    const forced = await runCli(
      ['cleanup', 'demo', path, '--force', '--no-trash', '--json'],
      sandbox,
    )
    expect(forced.json<{ removed: unknown[] }>().removed).toHaveLength(1)
    expect(existsSync(path)).toBe(false)
  })

  it('reports without removing under --dry-run', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'keep me')

    const result = await runCli(
      ['cleanup', 'demo', path, '--dry-run', '--json'],
      sandbox,
    )
    const data = result.json<{ dryRun: boolean; wouldRemove: unknown[] }>()
    expect(data.dryRun).toBe(true)
    expect(data.wouldRemove).toHaveLength(1)
    expect(existsSync(path)).toBe(true)
  })

  it('moves the worktree to the trash and prunes the registration', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'trash me')

    // Point the trash at a directory we control so the test stays hermetic.
    const trashDir = join(sandbox.root, 'trash')
    await mkdir(trashDir, { recursive: true })
    const result = await runCli(
      ['cleanup', 'demo', path, '--yes', '--json'],
      sandbox,
      { GROVE_TRASH_DIR: trashDir },
    )

    const data = result.json<{ removed: { trashed: boolean }[] }>()
    expect(data.removed).toHaveLength(1)
    expect(data.removed[0]?.trashed).toBe(true)

    // The files survive in the trash...
    const trashed = await readdir(trashDir)
    expect(trashed).toHaveLength(1)
    expect(existsSync(join(trashDir, trashed[0]!, 'README.md'))).toBe(true)

    // ...and git no longer lists the worktree.
    expect(existsSync(path)).toBe(false)
    const list = await runCli(['list', 'demo', '--json'], sandbox)
    const worktrees = list.json<{ worktrees: { path: string }[] }>().worktrees
    expect(worktrees.map((wt) => wt.path)).not.toContain(path)
  })

  it('falls back to a trash folder beside the worktrees', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'local trash')

    // What happens inside Claude Code's sandbox, where ~/.Trash is unwritable.
    const result = await runCli(
      ['cleanup', 'demo', path, '--yes', '--json'],
      sandbox,
      { GROVE_SYSTEM_TRASH: '0' },
    )
    const outcome = result.json<{
      removed: { trashed: boolean; trashDir: string | null }[]
    }>().removed[0]
    expect(outcome).toMatchObject({ trashed: true })

    const trashRoot = join(sandbox.repoPath, '.grove-trash')
    expect(outcome?.trashDir?.startsWith(trashRoot)).toBe(true)
    expect(existsSync(join(outcome!.trashDir!, basename(path), 'README.md'))).toBe(true)
    expect(await readFile(join(trashRoot, '.gitignore'), 'utf8')).toBe('*\n')
    expect(existsSync(path)).toBe(false)
  })

  it('does not permanently delete when moving to trash fails', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'trash failure')

    // Moving a directory into one of its own descendants always fails.
    const result = await runCli(
      ['cleanup', 'demo', path, '--force', '--json'],
      sandbox,
      { GROVE_TRASH_DIR: join(path, 'trash') },
    )
    const data = result.json<{ removed: unknown[]; skipped: { reason: string }[] }>()
    expect(data.removed).toEqual([])
    expect(data.skipped[0]?.reason).toMatch(/--no-trash/)
    expect(existsSync(path)).toBe(true)
  })

  it('aborts when git cannot inspect worktree status', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'broken metadata')

    const result = await runCli(
      ['cleanup', 'demo', path, '--yes', '--no-trash', '--json'],
      sandbox,
      // Worktree enumeration does not read the index, but status must reject
      // a directory where it expects an index file on every supported OS.
      { GIT_INDEX_FILE: sandbox.root },
    )
    expectError(result, 'git_failed')
    expect(existsSync(path)).toBe(true)
  })

  it('deletes the branch with --delete-branch', async ({ sandbox }) => {
    const { path, branch } = await newWorktree(sandbox, 'branch gone')

    await runCli(
      ['cleanup', 'demo', path, '--yes', '--delete-branch', '--no-trash', '--json'],
      sandbox,
    )
    const branches = await gitIn(['branch', '--list', branch], sandbox.mainPath)
    expect(branches).toBe('')
  })

  describe('across every repo', () => {
    /** A clean worktree in `demo` and another in a second repo, `other`. */
    async function twoRepos(sandbox: Sandbox): Promise<string[]> {
      const demo = await newWorktree(sandbox, 'demo work')
      await runCli(['clone', sandbox.remote, 'other', '--no-alias', '--json'], sandbox)
      const other = await runCli(['new', 'other', '--title', 'other work', '--json'], sandbox)
      expect(other.exitCode, other.stdout || other.stderr).toBe(0)
      return [demo.path, other.json<{ path: string }>().path]
    }

    it('selects merged worktrees from every repo with --all --merged', async ({ sandbox }) => {
      const paths = await twoRepos(sandbox)

      const result = await runCli(['cleanup', '--all', '--merged', '--dry-run', '--json'], sandbox)

      expect(result.exitCode, result.stdout || result.stderr).toBe(0)
      const json = result.json<{ repos: string[]; wouldRemove: { repo: string; path: string }[] }>()
      expect(json.repos.sort()).toEqual(['demo', 'other'])
      expect(json.wouldRemove.map(({ repo, path }) => ({ repo, path }))).toEqual(
        expect.arrayContaining([
          { repo: 'demo', path: paths[0] },
          { repo: 'other', path: paths[1] },
        ]),
      )
    })

    it('removes from every repo, tagging each outcome with its repo', async ({ sandbox }) => {
      const paths = await twoRepos(sandbox)

      const result = await runCli(
        ['cleanup', '--all', '--merged', '--yes', '--no-trash', '--json'],
        sandbox,
      )

      expect(result.exitCode, result.stdout || result.stderr).toBe(0)
      const json = result.json<{ removed: { repo: string; path: string }[] }>()
      expect(json.removed.map(({ repo }) => repo).sort()).toEqual(['demo', 'other'])
      for (const path of paths) expect(existsSync(path)).toBe(false)
    })

    it('rejects --all with a repo argument', async ({ sandbox }) => {
      const result = await runCli(['cleanup', 'demo', '--all', '--json'], sandbox)

      expectError(result, 'conflicting_arguments')
    })

    it('offers All repos first in the repo picker, grouped by repo', async ({ sandbox }) => {
      const paths = await twoRepos(sandbox)

      const result = await runCliWithTty(['cleanup', '--dry-run'], sandbox, {}, {
        steps: [
          { answerWhen: 'All repos (2)', keys: '\r' },
          { answerWhen: 'Select worktrees to remove', keys: '\r' },
        ],
      })

      // The repo picker shows the same counts, so read only the worktree picker.
      const [, picker] = result.stderr.split('Select worktrees to remove')
      expect(picker).toContain('demo (1)')
      expect(picker).toContain('other (1)')
      const [, wouldRemove] = result.stderr.split('Would remove:')
      expect(wouldRemove).toBeDefined()
      expect(wouldRemove).toContain(`demo/${basename(paths[0]!)}`)
      expect(wouldRemove).toContain(`other/${basename(paths[1]!)}`)
    })
  })

  describe('interactive picker', () => {
    /** One preselected (clean, merged) worktree and one left unselected (dirty). */
    async function mixedWorktrees(sandbox: Sandbox): Promise<string[]> {
      const clean = await newWorktree(sandbox, 'all clean')
      const dirty = await newWorktree(sandbox, 'all dirty')
      const dirtyPath = dirty.path
      await writeFile(join(dirtyPath, 'wip.txt'), 'wip\n')
      return [clean.path, dirtyPath]
    }

    it('selects every worktree with a', async ({ sandbox }) => {
      const paths = await mixedWorktrees(sandbox)

      const result = await runCliWithTty(
        ['cleanup', 'demo', '--dry-run'],
        sandbox,
        {},
        { answerWhen: 'Select worktrees to remove', keys: 'a\r' },
      )

      // In clack's key footer, alongside the keys it lists itself.
      expect(stripVTControlCharacters(result.stderr)).toContain(
        'Space: select • a: all / none • Enter: confirm',
      )
      // The prompt itself lists every worktree, so only read past it.
      const [, wouldRemove] = result.stderr.split('Would remove:')
      expect(wouldRemove).toBeDefined()
      for (const path of paths) expect(wouldRemove).toContain(basename(path))
    })

    it('clears the selection when a is pressed with everything selected', async ({ sandbox }) => {
      await mixedWorktrees(sandbox)

      const result = await runCliWithTty(
        ['cleanup', 'demo', '--dry-run'],
        sandbox,
        {},
        { answerWhen: 'Select worktrees to remove', keys: 'aa\r' },
      )

      expect(result.stderr).toContain('Nothing selected.')
    })

    it('shows each repo\'s worktree count when picking a repo', async ({ sandbox }) => {
      await mixedWorktrees(sandbox)
      await runCli(['clone', sandbox.remote, 'other', '--no-alias', '--json'], sandbox)

      // Ctrl-C at the repo prompt: only what it rendered matters here.
      const result = await runCliWithTty(['cleanup'], sandbox, {}, {
        answerWhen: 'Which repo?',
        keys: '\x03',
      })

      expect(result.stderr).toContain('demo (2)')
      expect(result.stderr).toContain('other (0)')
    })
  })
})
