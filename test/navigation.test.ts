import { describe, expect } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  runCli,
  runCliWithTty,
  gitIn,
  commitAt,
} from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'
import { newWorktree, expectError } from './helpers/grove.js'

describe('wt list', () => {
  it('treats a branch pushed without -u as pushed', async ({ sandbox }) => {
    const { path, branch } = await newWorktree(sandbox, 'no tracking')
    await gitIn(['commit', '--allow-empty', '-m', 'work'], path)
    // What a sandboxed agent can do: push without recording an upstream.
    await gitIn(['push', 'origin', 'HEAD'], path)
    await gitIn(['commit', '--allow-empty', '-m', 'more work'], path)

    const list = await runCli(['list', 'demo', '--status', '--json'], sandbox)
    const entry = list
      .json<{ worktrees: { path: string; upstream: string | null; ahead: number }[] }>()
      .worktrees.find((wt) => wt.path === path)
    expect(entry).toMatchObject({ upstream: `origin/${branch}`, ahead: 1 })
  })

  it('marks the main worktree and reports dirty state', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'dirty work')
    await writeFile(join(path, 'scratch.txt'), 'uncommitted\n')

    const result = await runCli(['list', 'demo', '--json'], sandbox)
    const data = result.json<{
      worktrees: { path: string; isMain: boolean; dirty: boolean }[]
    }>()
    expect(data.worktrees[0]?.isMain).toBe(true)
    const entry = data.worktrees.find((wt) => wt.path === path)
    expect(entry?.dirty).toBe(true)
  })

  it('tells a branch with no commits of its own apart from a merged one', async ({ sandbox }) => {
    type Entry = { dir: string; isMain: boolean; merged: boolean; behindBase: number | null }
    const list = async () =>
      (await runCli(['list', 'demo', '--json'], sandbox)).json<{ worktrees: Entry[] }>()
        .worktrees
    const find = (entries: Entry[], suffix: string) =>
      entries.find((entry) => entry.dir.endsWith(suffix))

    const fresh = await newWorktree(sandbox, 'fresh')
    const feature = await newWorktree(sandbox, 'feature')
    const featurePath = feature.path
    expect(find(await list(), 'fresh')).toMatchObject({ merged: true, behindBase: 0 })

    // Merge the feature through a merge commit and publish it, so origin/main
    // moves on past the fresh branch.
    await gitIn(['commit', '--allow-empty', '-m', 'feature work'], featurePath)
    await gitIn(['merge', '--no-ff', '-m', 'merge feature', 'test/feature'], sandbox.mainPath)
    await gitIn(['push', 'origin', 'main'], sandbox.mainPath)
    await gitIn(['fetch', 'origin'], sandbox.mainPath)

    const after = await list()
    expect(find(after, 'feature')).toMatchObject({ merged: true, behindBase: null })
    // Behind by the feature commit and the merge commit, counted as git does.
    expect(find(after, 'fresh')).toMatchObject({ merged: true, behindBase: 2 })
    expect(after[0]).toMatchObject({ isMain: true, behindBase: 0 })
  })

  it('keeps main first and orders the rest newest commit first', async ({ sandbox }) => {
    const paths: string[] = []
    for (const title of ['alpha work', 'beta work']) {
      const created = await newWorktree(sandbox, title)
      paths.push(created.path)
    }
    const [alpha, beta] = paths as [string, string]
    // git lists alpha before beta, so give beta the later commit to prove the
    // order comes from commit dates rather than git's listing.
    await commitAt(['commit', '--allow-empty', '-m', 'alpha'], alpha, '2030-01-01T00:00:00Z')
    await commitAt(['commit', '--allow-empty', '-m', 'beta'], beta, '2031-01-01T00:00:00Z')

    const result = await runCli(['list', 'demo', '--json'], sandbox)
    const data = result.json<{ worktrees: { path: string; isMain: boolean }[] }>()
    expect(data.worktrees[0]?.isMain).toBe(true)
    expect(data.worktrees.slice(1).map((wt) => wt.path)).toEqual([beta, alpha])
  })
})

describe('wt pick', () => {
  it('resolves a unique substring match', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'unique name here')

    const result = await runCli(['pick', 'demo', 'unique', '--json'], sandbox)
    expect(result.json<{ path: string }>().path).toBe(path)
  })

  it('shows each worktree\'s status in the picker', async ({ sandbox }) => {
    const created = await newWorktree(sandbox, 'messy work')
    await writeFile(join(created.path, 'scratch.txt'), 'wip\n')

    const result = await runCliWithTty(
      ['pick', 'demo'],
      sandbox,
      { GROVE_SHELL_INTEGRATION: '1' },
      { answerWhen: 'Clean up worktrees' },
    )

    expect(result.stderr).toMatch(/messy-work\s+● uncommitted changes/)
    // Main counts as merged into its own upstream, which says nothing useful.
    expect(result.stderr).not.toMatch(/main\s+○ clean\s+✔ merged/)
    expect(result.exitCode).toBe(0)
  })

  it('hands over to cleanup from the picker', async ({ sandbox }) => {
    await newWorktree(sandbox, 'finished work')

    // Up from the first row wraps to the cleanup entry at the bottom.
    const result = await runCliWithTty(
      ['pick', 'demo'],
      sandbox,
      { GROVE_SHELL_INTEGRATION: '1' },
      { answerWhen: 'Clean up worktrees', keys: '\x1b[A\r' },
    )

    expect(result.stderr).toContain('Select worktrees to remove')
    expect(result.stdout).not.toContain('__WT_CD__')
  })

  it('jumps to main with --main', async ({ sandbox }) => {
    const result = await runCli(['pick', 'demo', '--main', '--json'], sandbox)
    expect(result.json<{ path: string }>().path).toBe(sandbox.mainPath)
  })
})

describe('shell integration', () => {
  it('emits a cd sentinel only when the wrapper is active', async ({ sandbox }) => {
    const { path } = await newWorktree(sandbox, 'cd target')

    const withWrapper = await runCli(['pick', 'demo', path], sandbox, {
      GROVE_SHELL_INTEGRATION: '1',
    })
    expect(withWrapper.stdout.trim()).toBe(`__WT_CD__${path}`)

    const withoutWrapper = await runCli(['pick', 'demo', path], sandbox)
    expect(withoutWrapper.stdout.trim()).toBe(path)
  })

  it('generates a wrapper for each supported shell', async ({ sandbox }) => {
    const expected = {
      zsh: ['wt()', '__WT_CD__', 'command grove'],
      fish: ['function wt', '__WT_CD__'],
      powershell: ['Set-Location', '__WT_CD__'],
    }
    for (const [shell, snippets] of Object.entries(expected)) {
      const result = await runCli(['shell-init', shell], sandbox)
      expect(result.exitCode, shell).toBe(0)
      for (const snippet of snippets) expect(result.stdout, shell).toContain(snippet)
    }
  })

  /**
   * The wrapper reads stdout with `$(...)`, so a prompt rendered there would
   * be invisible to the user and would wreck the sentinel line the wrapper
   * matches on. Prompts must therefore render to stderr.
   */
  it('renders prompts on stderr, leaving stdout as a clean sentinel', async ({ sandbox }) => {
    const result = await runCliWithTty(
      ['clone', sandbox.remote, 'prompted'],
      sandbox,
      { GROVE_SHELL_INTEGRATION: '1' },
      { answerWhen: 'Short alias for' },
    )

    // The alias prompt was shown, and it was shown on stderr.
    expect(result.stderr).toContain('Short alias for')

    // stdout carries the sentinel and nothing else, so the wrapper can cd.
    const mainPath = join(sandbox.root, 'code', 'prompted', 'main')
    expect(result.stdout.trim()).toBe(`__WT_CD__${mainPath}`)
  })
})

describe('grove __complete', () => {
  it('lists repos as value/description pairs', async ({ sandbox }) => {
    const result = await runCli(['__complete', 'repos'], sandbox)
    expect(result.exitCode).toBe(0)
    const [name, description] = result.stdout.trim().split('\t')
    expect(name).toBe('demo')
    expect(description).toBe(sandbox.repoPath)
  })

  it('lists worktrees for a repo', async ({ sandbox }) => {
    await newWorktree(sandbox, 'completion target')
    const result = await runCli(['__complete', 'worktrees', 'demo'], sandbox)
    const dirs = result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('\t')[0])
    expect(dirs).toContain('main')
    // Matched by suffix: the directory carries today's yymmdd prefix, so
    // pinning the literal date makes the test pass only on the day it was
    // written.
    expect(dirs).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\d{6}-completion-target$/)]),
    )
  })

  it('lists branches and flags those already checked out', async ({ sandbox }) => {
    await newWorktree(sandbox, 'on a branch')
    const result = await runCli(['__complete', 'branches', 'demo'], sandbox)
    const rows = result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('\t'))
    const checked = rows.find((row) => row[0] === 'test/on-a-branch')
    expect(checked?.[1]).toBe('already checked out')
    expect(rows.map((row) => row[0])).toContain('main')
  })

  it('stays silent and succeeds for an unknown repo or category', async ({ sandbox }) => {
    for (const args of [['worktrees', 'nope'], ['nonsense']]) {
      const result = await runCli(['__complete', ...args], sandbox)
      expect(result.exitCode, args.join(' ')).toBe(0)
      expect(result.stdout.trim(), args.join(' ')).toBe('')
    }
  })
})
