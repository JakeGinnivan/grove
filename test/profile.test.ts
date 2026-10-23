import { describe, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  runCli,
  gitWithGlobalConfig,
} from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'
import { expectError, addProfile, readClaudeSettings } from './helpers/grove.js'

/**
 * grove spells paths with forward slashes inside git config files, because
 * git reads `\\` as an escape character. Mirror that when asserting on the
 * generated config so these expectations hold on Windows too.
 */
const inGitConfig = (path: string) => path.replaceAll('\\', '/')

describe('grove profile', () => {
  it('adds a profile and reports it as JSON', async ({ sandbox }) => {
    const dir = join(sandbox.root, 'work')
    await runCli(
      [
        'profile',
        'add',
        'work',
        dir,
        '--description',
        'Internal work code',
        '--rule',
        'Do not copy code out of this profile',
        '--json',
      ],
      sandbox,
    )

    const list = await runCli(['profile', 'list', '--json'], sandbox)
    const data = list.json<{
      profiles: {
        name: string
        dir: string
        description: string | null
        rules: string[]
      }[]
    }>()
    expect(data.profiles).toHaveLength(1)
    expect(data.profiles[0]).toMatchObject({
      name: 'work',
      dir,
      description: 'Internal work code',
      rules: ['Do not copy code out of this profile'],
    })
  })

  it('uses the only profile when just one is configured', async ({ sandbox }) => {
    const workDir = join(sandbox.root, 'work')
    await addProfile(sandbox, 'work')
    const result = await runCli(
      ['clone', sandbox.remote, 'routed', '--no-alias', '--json'],
      sandbox,
    )
    const data = result.json<{ profile: string; path: string }>()
    expect(data.profile).toBe('work')
    expect(data.path).toBe(join(workDir, 'routed'))
  })

  it('honours an explicit --profile over the default', async ({ sandbox }) => {
    const ossDir = join(sandbox.root, 'oss')
    await addProfile(sandbox, 'work')
    await addProfile(sandbox, 'oss')

    const result = await runCli(
      ['clone', sandbox.remote, 'chosen', '--profile', 'oss', '--no-alias', '--json'],
      sandbox,
    )
    expect(result.json<{ path: string }>().path).toBe(join(ossDir, 'chosen'))
  })

  it('requires a profile when several exist and no default is set', async ({ sandbox }) => {
    await addProfile(sandbox, 'work')
    await addProfile(sandbox, 'oss')

    const result = await runCli(
      ['clone', sandbox.remote, 'ambiguous', '--no-alias', '--json'],
      sandbox,
    )
    const error = expectError(result, 'needs_input')
    expect(error.hint).toContain('--profile')
  })

  it('uses the default profile when set', async ({ sandbox }) => {
    const ossDir = join(sandbox.root, 'oss')
    await addProfile(sandbox, 'work')
    await addProfile(sandbox, 'oss', '--default')

    const result = await runCli(
      ['clone', sandbox.remote, 'defaulted', '--no-alias', '--json'],
      sandbox,
    )
    expect(result.json<{ profile: string }>().profile).toBe('oss')
  })

  it('sets, shows, and clears the default with `profile default`', async ({ sandbox }) => {
    const ossDir = join(sandbox.root, 'oss')
    await addProfile(sandbox, 'work')
    await addProfile(sandbox, 'oss')

    // Nothing set yet.
    const initial = await runCli(['profile', 'default', '--json'], sandbox)
    expect(initial.json<{ defaultProfile: string | null }>().defaultProfile).toBeNull()

    const set = await runCli(['profile', 'default', 'oss', '--json'], sandbox)
    expect(set.json<{ defaultProfile: string }>().defaultProfile).toBe('oss')

    // It now drives clone routing.
    const clone = await runCli(
      ['clone', sandbox.remote, 'viadefault', '--no-alias', '--json'],
      sandbox,
    )
    expect(clone.json<{ profile: string }>().profile).toBe('oss')

    const shown = await runCli(['profile', 'default', '--json'], sandbox)
    expect(shown.json<{ defaultProfile: string }>().defaultProfile).toBe('oss')

    const cleared = await runCli(['profile', 'default', '--clear', '--json'], sandbox)
    expect(cleared.json<{ defaultProfile: string | null }>().defaultProfile).toBeNull()
  })

  it('rejects an unknown profile as the default', async ({ sandbox }) => {
    await addProfile(sandbox, 'work')
    const result = await runCli(['profile', 'default', 'nope', '--json'], sandbox)
    expectError(result, 'unknown_profile')
  })

  it('clears the default when that profile is removed', async ({ sandbox }) => {
    await addProfile(sandbox, 'work')
    await addProfile(sandbox, 'oss')
    await runCli(['profile', 'default', 'oss', '--json'], sandbox)

    await runCli(['profile', 'remove', 'oss', '--json'], sandbox)
    const after = await runCli(['profile', 'default', '--json'], sandbox)
    expect(after.json<{ defaultProfile: string | null }>().defaultProfile).toBeNull()
  })
})

describe('grove profile add writes config immediately', () => {
  it('writes git and Claude config without a separate apply step', async ({ sandbox }) => {
    const workDir = join(sandbox.root, 'work')
    const result = await runCli(['profile', 'add', 'work', workDir, '--json'], sandbox)
    expect(result.exitCode).toBe(0)

    // The files exist straight away — no `profile apply` was run.
    const profileConfig = await readFile(join(workDir, '.gitconfig'), 'utf8')
    expect(profileConfig).toContain('# Profile: work')

    const globalConfig = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')
    expect(globalConfig).toContain(
      `[includeIf "gitdir:${inGitConfig(workDir)}/"]`,
    )

    const settings = await readClaudeSettings<{ permissions: { additionalDirectories: string[] } }>(sandbox)
    expect(settings.permissions.additionalDirectories).toContain(workDir)

    // And the response reports exactly which files it touched.
    const wrote = result.json<{ wrote: string[] }>().wrote
    expect(wrote).toContain(join(workDir, '.gitconfig'))
    expect(wrote).toContain(join(sandbox.root, '.claude', 'settings.json'))
  })

  it('leaves config alone with --no-apply', async ({ sandbox }) => {
    const workDir = join(sandbox.root, 'work')
    const result = await runCli(['profile', 'add', 'work', workDir, '--no-apply', '--json'], sandbox)
    expect(result.json<{ wrote: string[] }>().wrote).toEqual([])
    expect(existsSync(join(workDir, '.gitconfig'))).toBe(false)
    expect(existsSync(join(sandbox.root, '.claude', 'settings.json'))).toBe(false)

    // A later apply still picks it up.
    await runCli(['profile', 'apply', '--yes', '--json'], sandbox)
    expect(existsSync(join(workDir, '.gitconfig'))).toBe(true)
  })

  it('a follow-up apply reports nothing left to do', async ({ sandbox }) => {
    await addProfile(sandbox, 'work')
    const apply = await runCli(['profile', 'apply', '--yes', '--json'], sandbox)
    const changes = apply.json<{ changes: { changed: boolean }[] }>().changes
    expect(changes.every((change) => !change.changed)).toBe(true)
  })

  it('removing a profile drops its includeIf stanza', async ({ sandbox }) => {
    const workDir = join(sandbox.root, 'work')
    const ossDir = join(sandbox.root, 'oss')
    await addProfile(sandbox, 'work')
    await addProfile(sandbox, 'oss')
    expect(await readFile(join(sandbox.root, '.gitconfig'), 'utf8')).toContain(
      `gitdir:${inGitConfig(workDir)}/`,
    )

    await runCli(['profile', 'remove', 'work', '--json'], sandbox)
    const after = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')
    expect(after).not.toContain(`gitdir:${inGitConfig(workDir)}/`)
    // The surviving profile keeps its stanza.
    expect(after).toContain(`gitdir:${inGitConfig(ossDir)}/`)
  })

  it('removing a profile revokes only Claude permissions Grove added', async ({ sandbox }) => {
    const workDir = join(sandbox.root, 'work')
    await mkdir(join(sandbox.root, '.claude'), { recursive: true })
    await writeFile(
      join(sandbox.root, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: {
          additionalDirectories: ['/user-owned'],
          allow: ['Read(/user-owned/**)'],
        },
      }),
    )

    await addProfile(sandbox, 'work')
    await runCli(['profile', 'remove', 'work', '--json'], sandbox)

    const settings = await readClaudeSettings<{ permissions: { additionalDirectories: string[]; allow: string[] } }>(sandbox)
    expect(settings.permissions.additionalDirectories).not.toContain(workDir)
    expect(settings.permissions.allow).not.toContain(`Read(${workDir}/**)`)
    expect(settings.permissions.additionalDirectories).toContain('/user-owned')
    expect(settings.permissions.allow).toContain('Read(/user-owned/**)')
  })

  it('removing a profile strips the managed block but keeps hand-written config', async ({ sandbox }) => {
    const workDir = join(sandbox.root, 'work')
    await addProfile(sandbox, 'work')

    const profileConfig = join(workDir, '.gitconfig')
    expect(await readFile(profileConfig, 'utf8')).toContain('grove managed')

    // A setting the user added themselves, below grove's block.
    await writeFile(
      profileConfig,
      `${await readFile(profileConfig, 'utf8')}\n[user]\n\temail = work@example.com\n`,
    )

    await runCli(['profile', 'remove', 'work', '--json'], sandbox)
    const after = await readFile(profileConfig, 'utf8')
    expect(after).not.toContain('grove managed')
    expect(after).toContain('email = work@example.com')
  })

  it('removing the last profile clears the managed block entirely', async ({ sandbox }) => {
    const workDir = join(sandbox.root, 'work')
    await writeFile(join(sandbox.root, '.gitconfig'), '[user]\n\tname = Someone\n')
    await addProfile(sandbox, 'work')

    await runCli(['profile', 'remove', 'work', '--json'], sandbox)
    const after = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')

    expect(after).not.toContain('grove managed')
    expect(after).not.toContain('includeIf')
    // Hand-written config is untouched.
    expect(after).toContain('name = Someone')
  })
})

describe('grove profile apply', () => {
  it('writes the per-profile gitconfig and Claude read permissions', async ({ sandbox }) => {
    const workDir = join(sandbox.root, 'work')
    await addProfile(sandbox, 'work')
    const result = await runCli(['profile', 'apply', '--yes', '--json'], sandbox)
    expect(result.exitCode).toBe(0)

    // Per-profile gitconfig exists, ready for the user's own settings.
    const profileConfig = await readFile(join(workDir, '.gitconfig'), 'utf8')
    expect(profileConfig).toContain('# Profile: work')

    // Global gitconfig includes it only for paths under the profile dir.
    const globalConfig = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')
    expect(globalConfig).toContain(
      `[includeIf "gitdir:${inGitConfig(workDir)}/"]`,
    )

    // Claude gains read access to the profile directory.
    const settings = await readClaudeSettings<{ permissions: { additionalDirectories: string[]; allow: string[] } }>(sandbox)
    expect(settings.permissions.additionalDirectories).toContain(workDir)
    expect(settings.permissions.allow).toContain(`Read(${workDir}/**)`)
  })

  it('preserves existing Claude settings', async ({ sandbox }) => {
    await mkdir(join(sandbox.root, '.claude'), { recursive: true })
    await writeFile(
      join(sandbox.root, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(ls:*)'], defaultMode: 'auto' },
      }),
    )
    await addProfile(sandbox, 'work')
    await runCli(['profile', 'apply', '--yes', '--json'], sandbox)

    const settings = await readClaudeSettings<{
      model: string
      permissions: { allow: string[]; defaultMode: string }
    }>(sandbox)
    expect(settings.model).toBe('opus')
    expect(settings.permissions.defaultMode).toBe('auto')
    expect(settings.permissions.allow).toContain('Bash(ls:*)')
  })

  it('is idempotent and does not duplicate managed blocks', async ({ sandbox }) => {
    await runCli(
      [
        'profile',
        'add',
        'work',
        join(sandbox.root, 'work'),
        '--json',
      ],
      sandbox,
    )
    await runCli(['profile', 'apply', '--yes', '--json'], sandbox)
    const first = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')

    const second = await runCli(['profile', 'apply', '--yes', '--json'], sandbox)
    const after = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')

    expect(after).toBe(first)
    expect(after.match(/grove managed/g)).toHaveLength(2) // one begin, one end
    const changes = second.json<{ changes: { changed: boolean }[] }>().changes
    expect(changes.every((change) => !change.changed)).toBe(true)
  })

  it('preserves unmanaged content in the global gitconfig', async ({ sandbox }) => {
    await writeFile(
      join(sandbox.root, '.gitconfig'),
      '[user]\n\tname = Someone\n\temail = someone@example.com\n',
    )
    await addProfile(sandbox, 'work')
    await runCli(['profile', 'apply', '--yes', '--json'], sandbox)

    const config = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')
    expect(config).toContain('name = Someone')
    expect(config).toContain('includeIf')
  })

  it('does not grant read access to a default dir holding no repos', async ({ sandbox }) => {
    // The sandbox registry lives under <root>/code, and the demo repo is
    // there, so <root>/code is legitimately included; a profile elsewhere
    // must not drag in unrelated directories.
    const workDir = join(sandbox.root, 'work')
    await addProfile(sandbox, 'work')
    await runCli(['profile', 'apply', '--yes', '--json'], sandbox)

    const settings = await readClaudeSettings<{ permissions: { additionalDirectories: string[] } }>(sandbox)
    const dirs = settings.permissions.additionalDirectories

    expect(dirs).toContain(workDir)
    // No entry may be nested inside another; that would be redundant scope.
    for (const dir of dirs) {
      const nested = dirs.filter((other) => other !== dir && dir.startsWith(`${other}/`))
      expect(nested).toEqual([])
    }
  })

  it('reports changes without writing under --dry-run', async ({ sandbox }) => {
    // --no-apply keeps `add` from writing, so --dry-run has pending work to
    // report and we can prove it writes nothing.
    const workDir = join(sandbox.root, 'work')
    await addProfile(sandbox, 'work', '--no-apply')

    const result = await runCli(['profile', 'apply', '--dry-run', '--json'], sandbox)
    const data = result.json<{ dryRun: boolean; changes: { changed: boolean }[] }>()

    expect(data.dryRun).toBe(true)
    expect(data.changes.some((change) => change.changed)).toBe(true)
    expect(existsSync(join(sandbox.root, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(workDir, '.gitconfig'))).toBe(false)
  })

  it('the generated includeIf actually engages for repos in the profile', async ({ sandbox }) => {
    // The real proof: git must load the per-profile config, not merely have
    // it written. git matches `gitdir:` against the realpath, so a profile
    // dir stored uncanonicalised would silently never match.
    const workDir = join(sandbox.root, 'work')
    await addProfile(sandbox, 'work')
    await runCli(['profile', 'apply', '--yes', '--json'], sandbox)

    // A hand-written setting below the managed block, the way a user would
    // add a profile-specific email or signing key.
    const profileConfig = join(workDir, '.gitconfig')
    await writeFile(
      profileConfig,
      `${await readFile(profileConfig, 'utf8')}\n[user]\n\temail = work@example.com\n`,
    )

    const repo = join(workDir, 'includetest')
    await mkdir(repo, { recursive: true })
    const gitHere = gitWithGlobalConfig(sandbox)
    await gitHere(['init', '-q', repo], sandbox.root)

    // Resolved through the includeIf, so the profile config is live.
    expect(await gitHere(['config', '--get', 'user.email'], repo)).toBe(
      'work@example.com',
    )

    // A repo outside the profile directory does not pick it up.
    const outside = join(sandbox.root, 'elsewhere')
    await mkdir(outside, { recursive: true })
    await gitHere(['init', '-q', outside], sandbox.root)
    await expect(
      gitHere(['config', '--get', 'user.email'], outside),
    ).rejects.toThrow()
  })
})
