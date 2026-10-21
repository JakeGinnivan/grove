import { describe, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  runCli,
  gitIn,
  type Sandbox,
} from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'

describe('wt create', () => {
  it('creates a repo in the main/ layout and registers it', async ({ sandbox }) => {
    const result = await runCli(['create', 'fresh', '--no-alias', '--json'], sandbox)
    expect(result.exitCode).toBe(0)
    const data = result.json<{
      name: string
      path: string
      mainPath: string
      branch: string
    }>()
    expect(data).toMatchObject({
      name: 'fresh',
      path: join(sandbox.root, 'code', 'fresh'),
      mainPath: join(sandbox.root, 'code', 'fresh', 'main'),
      branch: 'main',
    })
    expect(existsSync(join(data.mainPath, '.git'))).toBe(true)
  })

  it('defaults the initial branch to main regardless of git config', async ({ sandbox }) => {
    const result = await runCli(['create', 'branchy', '--no-alias', '--json'], sandbox,
      { GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_1: 'init.defaultBranch',
        GIT_CONFIG_VALUE_1: 'master' },
    )
    const data = result.json<{ mainPath: string; branch: string }>()
    expect(data.branch).toBe('main')
    expect(await gitIn(['symbolic-ref', '--short', 'HEAD'], data.mainPath)).toBe('main')
  })

  it('honours an explicit --branch', async ({ sandbox }) => {
    const result = await runCli(
      ['create', 'trunky', '-b', 'trunk', '--no-alias', '--json'],
      sandbox,
    )
    const data = result.json<{ mainPath: string; branch: string }>()
    expect(data.branch).toBe('trunk')
    expect(await gitIn(['symbolic-ref', '--short', 'HEAD'], data.mainPath)).toBe('trunk')
  })

  it('leaves the repo without commits', async ({ sandbox }) => {
    const result = await runCli(['create', 'unborn', '--no-alias', '--json'], sandbox)
    const { mainPath } = result.json<{ mainPath: string }>()
    // An unborn HEAD has no commits to count, so rev-list fails.
    await expect(gitIn(['rev-parse', 'HEAD'], mainPath)).rejects.toThrow()
  })

  it('refuses to overwrite an existing checkout', async ({ sandbox }) => {
    await runCli(['create', 'twice', '--no-alias', '--json'], sandbox)
    const result = await runCli(['create', 'twice', '--no-alias', '--json'], sandbox)
    expect(result.exitCode).toBe(1)
    const error = result.json<{ error: { code: string; hint: string } }>().error
    expect(error.code).toBe('create_target_exists')
    expect(error.hint).toContain('grove import')
  })

  it('routes into a profile directory like clone does', async ({ sandbox }) => {
    const ossDir = join(sandbox.root, 'oss')
    await runCli(['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'], sandbox)
    await runCli(['profile', 'add', 'oss', ossDir, '--json'], sandbox)

    const result = await runCli(
      ['create', 'scoped', '--profile', 'oss', '--no-alias', '--json'],
      sandbox,
    )
    const data = result.json<{ path: string; profile: string }>()
    expect(data.profile).toBe('oss')
    expect(data.path).toBe(join(ossDir, 'scoped'))
  })

  it('requires a profile when several exist and no default is set', async ({ sandbox }) => {
    await runCli(['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'], sandbox)
    await runCli(['profile', 'add', 'oss', join(sandbox.root, 'oss'), '--json'], sandbox)

    const result = await runCli(['create', 'ambiguous', '--no-alias', '--json'], sandbox)
    expect(result.exitCode).toBe(2)
    const error = result.json<{ error: { code: string; hint: string } }>().error
    expect(error.code).toBe('needs_input')
    expect(error.hint).toContain('--profile')
  })

  it('supports a worktree once the first commit exists', async ({ sandbox }) => {
    const created = await runCli(['create', 'growing', '--no-alias', '--json'], sandbox)
    const { mainPath } = created.json<{ mainPath: string }>()

    // `grove create` runs `git init`, so this repo has no identity of its own,
    // and the fixtures deliberately run git with no global config. A developer
    // machine has one to fall back on; a CI agent does not.
    await gitIn(['config', 'user.email', 'test@example.com'], mainPath)
    await gitIn(['config', 'user.name', 'Test'], mainPath)

    await writeFile(join(mainPath, 'README.md'), '# growing\n')
    await gitIn(['add', '.'], mainPath)
    await gitIn(['commit', '-m', 'initial'], mainPath)

    // No remote, so the base has to be named explicitly.
    const result = await runCli(
      ['new', 'growing', '--title', 'first task', '--base', 'main', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{ path: string; branch: string }>()
    expect(data.branch).toBe('test/first-task')
    expect(existsSync(data.path)).toBe(true)
  })
})

describe('wt create --github', () => {
  /**
   * A stand-in for the GitHub CLI. Tests must never touch the network, so the
   * real `gh` is shadowed by a script on PATH that records its arguments and
   * reports whatever auth state the test needs.
   */
  async function fakeGh(
    sandbox: Sandbox,
    authOutput: string,
    { exitCode = 0 }: { exitCode?: number } = {},
  ): Promise<{ binDir: string; logFile: string }> {
    const binDir = join(sandbox.root, 'fakebin')
    const logFile = join(sandbox.root, 'gh-calls.log')
    await mkdir(binDir, { recursive: true })
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "auth" ]; then',
      `cat <<'AUTH'`,
      authOutput,
      'AUTH',
      `exit ${exitCode}`,
      'fi',
      'if [ "$1" = "repo" ] && [ "$2" = "create" ]; then',
      `  echo "$@" >> "${logFile}"`,
      '  exit 0',
      'fi',
      'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then',
      `  echo '{"nameWithOwner":"me/thing","url":"https://github.com/me/thing"}'`,
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n')
    await writeFile(join(binDir, 'gh'), `${script}\n`, { mode: 0o755 })
    return { binDir, logFile }
  }

  const LOGGED_IN = 'github.com\n  - Active account: true'
  const BAD_TOKEN =
    'github.com\n  X Failed to log in to github.com account me (keyring)\n  - The token in keyring is invalid.'

  it('creates the repo on GitHub and reports it', async ({ sandbox }) => {
    const { binDir, logFile } = await fakeGh(sandbox, LOGGED_IN)

    const result = await runCli(
      ['create', 'thing', '--github', '--no-alias', '--json'],
      sandbox,
      { PATH: `${binDir}:${process.env['PATH']}`, GROVE_NO_GITHUB: '' },
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{
      mainPath: string
      github: { nameWithOwner: string; url: string } | null
    }>()
    expect(data.github).toEqual({
      nameWithOwner: 'me/thing',
      url: 'https://github.com/me/thing',
    })

    // Private by default, wired as origin, pointed at the main checkout.
    const call = await readFile(logFile, 'utf8')
    expect(call).toContain('--private')
    expect(call).toContain('--remote origin')
    expect(call).toContain(data.mainPath)
    // Nothing is pushed: a fresh repo has no commits to push.
    expect(call).not.toContain('--push')
  })

  it('passes an explicit visibility through', async ({ sandbox }) => {
    const { binDir, logFile } = await fakeGh(sandbox, LOGGED_IN)
    await runCli(
      ['create', 'pubthing', '--github', '--visibility', 'public', '--no-alias', '--json'],
      sandbox,
      { PATH: `${binDir}:${process.env['PATH']}`, GROVE_NO_GITHUB: '' },
    )
    expect(await readFile(logFile, 'utf8')).toContain('--public')
  })

  it('rejects an unknown visibility before calling gh', async ({ sandbox }) => {
    const { binDir, logFile } = await fakeGh(sandbox, LOGGED_IN)
    const result = await runCli(
      ['create', 'badvis', '--github', '--visibility', 'hush', '--no-alias', '--json'],
      sandbox,
      { PATH: `${binDir}:${process.env['PATH']}`, GROVE_NO_GITHUB: '' },
    )
    expect(result.exitCode).toBe(1)
    expect(result.json<{ error: { code: string } }>().error.code).toBe(
      'invalid_visibility',
    )
    expect(existsSync(logFile)).toBe(false)
  })

  it('treats an invalid gh token as unavailable, keeping the local repo', async ({ sandbox }) => {
    const { binDir } = await fakeGh(sandbox, BAD_TOKEN)
    const result = await runCli(
      ['create', 'tok', '--github', '--no-alias', '--json'],
      sandbox,
      { PATH: `${binDir}:${process.env['PATH']}`, GROVE_NO_GITHUB: '' },
    )
    expect(result.exitCode).toBe(1)
    const error = result.json<{ error: { code: string; message: string } }>().error
    expect(error.code).toBe('gh_unavailable')
    expect(error.message).toContain('invalid or expired')

    // gh failing must not cost the user the local repo.
    expect(existsSync(join(sandbox.root, 'code', 'tok', 'main', '.git'))).toBe(true)
    const repos = await runCli(['repos', '--json'], sandbox)
    const names = repos.json<{ repos: { name: string }[] }>().repos.map((r) => r.name)
    expect(names).toContain('tok')
  })

  it('stays silent about GitHub when gh is unusable and none was asked for', async ({ sandbox }) => {
    const { binDir } = await fakeGh(sandbox, BAD_TOKEN)
    const result = await runCli(
      ['create', 'quiet', '--no-alias', '--json'],
      sandbox,
      { PATH: `${binDir}:${process.env['PATH']}`, GROVE_NO_GITHUB: '' },
    )
    expect(result.exitCode).toBe(0)
    expect(result.json<{ github: unknown }>().github).toBeNull()
  })

  it('never calls gh with --no-github', async ({ sandbox }) => {
    const { binDir, logFile } = await fakeGh(sandbox, LOGGED_IN)
    const result = await runCli(
      ['create', 'local', '--no-github', '--no-alias', '--json'],
      sandbox,
      { PATH: `${binDir}:${process.env['PATH']}`, GROVE_NO_GITHUB: '' },
    )
    expect(result.json<{ github: unknown }>().github).toBeNull()
    expect(existsSync(logFile)).toBe(false)
  })

  it('does not prompt for GitHub in non-interactive mode', async ({ sandbox }) => {
    const { binDir, logFile } = await fakeGh(sandbox, LOGGED_IN)
    // --json implies non-interactive: a prompt here would hang the run.
    const result = await runCli(
      ['create', 'unattended', '--no-alias', '--json'],
      sandbox,
      { PATH: `${binDir}:${process.env['PATH']}`, GROVE_NO_GITHUB: '' },
    )
    expect(result.exitCode).toBe(0)
    expect(result.json<{ github: unknown }>().github).toBeNull()
    expect(existsSync(logFile)).toBe(false)
  })
})
