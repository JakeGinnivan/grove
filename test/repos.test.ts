import { describe, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  runCli,
  gitIn,
  type Sandbox,
} from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'
import { expectError, addProfile } from './helpers/grove.js'

describe('wt repos', () => {
  it('reports the registered repo and its main path as JSON', async ({ sandbox }) => {
    const result = await runCli(['repos', '--json'], sandbox)
    expect(result.exitCode).toBe(0)
    const data = result.json<{
      ok: boolean
      repos: { name: string; path: string; mainPath: string; exists: boolean }[]
    }>()
    expect(data.ok).toBe(true)
    expect(data.repos).toHaveLength(1)
    expect(data.repos[0]).toMatchObject({
      name: 'demo',
      path: sandbox.repoPath,
      mainPath: sandbox.mainPath,
      exists: true,
    })
  })
})

describe('wt repos add (deprecated)', () => {
  it('forwards to import, warns, and leaves the layout alone', async ({ sandbox }) => {
    const path = join(sandbox.root, 'legacy')
    await gitIn(['clone', sandbox.remote, path], sandbox.root)

    const result = await runCli(
      ['repos', 'add', path, '--name', 'legacy', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{
      name: string
      mainPath: string
      restructured: boolean
      deprecated: string
    }>()
    expect(data.name).toBe('legacy')
    // The old command never restructured, and the shim keeps that behaviour.
    expect(data.restructured).toBe(false)
    expect(existsSync(join(path, '.git'))).toBe(true)
    // --json swallows the stderr warning, so the notice rides in the payload.
    expect(data.deprecated).toContain('grove import')

    const repos = await runCli(['repos', '--json'], sandbox)
    const names = repos.json<{ repos: { name: string }[] }>().repos.map((r) => r.name)
    expect(names).toContain('legacy')
  })

  it('warns on stderr in human mode', async ({ sandbox }) => {
    const path = join(sandbox.root, 'legacy2')
    await gitIn(['clone', sandbox.remote, path], sandbox.root)

    const result = await runCli(['repos', 'add', path, '--name', 'legacy2'], sandbox)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('deprecated')
    expect(result.stderr).toContain('grove import')
  })

  it('stays hidden from the repos help output', async ({ sandbox }) => {
    const result = await runCli(['repos', '--help'], sandbox)
    expect(result.stdout).not.toContain('add')
  })
})

describe('registry aliases', () => {
  it('refuses an alias that collides with an existing repo name', async ({ sandbox }) => {
    // Names and aliases share one namespace, so accepting this would delete
    // the existing repo's registration.
    const other = join(sandbox.root, 'code', 'other')
    await mkdir(other, { recursive: true })
    await runCli(['import', sandbox.repoPath, 'keepme', '--no-alias', '--json'], sandbox)

    const result = await runCli(
      ['import', sandbox.repoPath, 'newrepo', '--alias', 'keepme', '--json'],
      sandbox,
    )
    expectError(result, 'alias_conflicts_with_repo')

    // The existing repo survived.
    const repos = await runCli(['repos', '--json'], sandbox)
    const names = repos.json<{ repos: { name: string }[] }>().repos.map((r) => r.name)
    expect(names).toContain('keepme')
  })
})

describe('wt import', () => {
  /** A plain clone with no main/ subfolder — the layout import fixes up. */
  async function makePlainClone(sandbox: Sandbox, name: string): Promise<string> {
    const path = join(sandbox.root, name)
    await gitIn(['clone', sandbox.remote, path], sandbox.root)
    return path
  }

  it('moves a plain clone into main/ and registers the parent', async ({ sandbox }) => {
    const path = await makePlainClone(sandbox, 'loose')

    const result = await runCli(
      ['import', path, '--restructure', '--no-alias', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{
      name: string
      path: string
      mainPath: string
      restructured: boolean
    }>()
    expect(data).toMatchObject({
      name: 'loose',
      path,
      mainPath: join(path, 'main'),
      restructured: true,
    })

    // The checkout moved wholesale, history and all.
    expect(existsSync(join(path, 'main', '.git'))).toBe(true)
    expect(existsSync(join(path, '.git'))).toBe(false)
    expect(await gitIn(['log', '--oneline'], join(path, 'main'))).toContain('initial')
  })

  it('registers a plain clone as-is with --no-restructure', async ({ sandbox }) => {
    const path = await makePlainClone(sandbox, 'asis')

    const result = await runCli(
      ['import', path, '--no-restructure', '--no-alias', '--json'],
      sandbox,
    )
    const data = result.json<{ mainPath: string; restructured: boolean }>()
    expect(data.restructured).toBe(false)
    expect(data.mainPath).toBe(path)
    // Untouched: the checkout is still the folder itself.
    expect(existsSync(join(path, '.git'))).toBe(true)
  })

  it('demands a layout decision rather than moving files unasked', async ({ sandbox }) => {
    const path = await makePlainClone(sandbox, 'undecided')

    const result = await runCli(['import', path, '--no-alias', '--json'], sandbox)
    const error = expectError(result, 'needs_input')
    expect(error.hint).toContain('--restructure')
    // Nothing was moved while it was asking.
    expect(existsSync(join(path, '.git'))).toBe(true)
  })

  it('accepts an already-correct layout untouched', async ({ sandbox }) => {
    const result = await runCli(
      ['import', sandbox.repoPath, 'again', '--no-alias', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{ mainPath: string; restructured: boolean }>()
    expect(data.mainPath).toBe(sandbox.mainPath)
    expect(data.restructured).toBe(false)
  })

  it('names the repo after the parent when pointed at main/ itself', async ({ sandbox }) => {
    const result = await runCli(
      ['import', sandbox.mainPath, '--no-alias', '--json'],
      sandbox,
    )
    const data = result.json<{ name: string; path: string; mainPath: string }>()
    expect(data.name).toBe('demo')
    expect(data.path).toBe(sandbox.repoPath)
    expect(data.mainPath).toBe(sandbox.mainPath)
  })

  it('refuses to restructure a repo that has linked worktrees', async ({ sandbox }) => {
    // A worktree records its repo path, so moving the checkout would break it.
    const path = await makePlainClone(sandbox, 'withwt')
    await gitIn(['worktree', 'add', join(sandbox.root, 'wt-extra'), '-b', 'extra'], path)

    const result = await runCli(
      ['import', path, '--restructure', '--no-alias', '--json'],
      sandbox,
    )
    expectError(result, 'has_linked_worktrees')
    // Left exactly as it was.
    expect(existsSync(join(path, '.git'))).toBe(true)
  })

  it('rejects a path that is not a git repo', async ({ sandbox }) => {
    const path = join(sandbox.root, 'empty')
    await mkdir(path, { recursive: true })
    const result = await runCli(['import', path, '--json'], sandbox)
    expectError(result, 'not_a_repo')
  })

  it('points at the repo root when given a subdirectory of one', async ({ sandbox }) => {
    const path = await makePlainClone(sandbox, 'deep')
    const nested = join(path, 'nested')
    await mkdir(nested, { recursive: true })

    const result = await runCli(['import', nested, '--json'], sandbox)
    const error = expectError(result, 'not_repo_root')
    expect(error.hint).toContain('grove import')
  })

  it('moves the repo under a profile when asked', async ({ sandbox }) => {
    const workDir = join(sandbox.root, 'work')
    await addProfile(sandbox, 'work')
    const path = await makePlainClone(sandbox, 'relocate')

    const result = await runCli(
      ['import', path, '--restructure', '--profile', 'work', '--no-alias', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{
      path: string
      mainPath: string
      profile: string
      moved: boolean
    }>()
    expect(data).toMatchObject({
      path: join(workDir, 'relocate'),
      mainPath: join(workDir, 'relocate', 'main'),
      profile: 'work',
      moved: true,
    })
    expect(existsSync(path)).toBe(false)
    expect(await gitIn(['log', '--oneline'], data.mainPath)).toContain('initial')
  })

  it('registers the imported repo so other commands resolve it', async ({ sandbox }) => {
    const path = await makePlainClone(sandbox, 'usable')
    await runCli(
      ['import', path, '--restructure', '--alias', 'usbl', '--json'],
      sandbox,
    )

    const repos = await runCli(['repos', '--json'], sandbox)
    const names = repos
      .json<{ repos: { name: string; mainPath: string | null }[] }>()
      .repos.map((repo) => repo.name)
    expect(names).toContain('usable')
    expect(names).toContain('usbl')

    // The alias resolves through to a working checkout.
    const list = await runCli(['list', 'usbl', '--json'], sandbox)
    expect(list.exitCode).toBe(0)
  })
})
