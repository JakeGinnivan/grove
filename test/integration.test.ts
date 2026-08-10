import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createSandbox,
  runCli,
  gitIn,
  gitWithGlobalConfig,
  type Sandbox,
} from './helpers/sandbox.js'

let sandbox: Sandbox

beforeEach(async () => {
  sandbox = await createSandbox()
})

afterEach(async () => {
  await sandbox.cleanup()
})

describe('wt repos', () => {
  it('reports the registered repo and its main path as JSON', async () => {
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

describe('wt new', () => {
  it('creates a worktree and branch from the default base', async () => {
    const result = await runCli(
      ['new', 'demo', '--title', 'fix login', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{ path: string; branch: string; base: string }>()
    expect(data.branch).toBe('test/fix-login')
    expect(data.base).toBe('origin/main')
    expect(existsSync(data.path)).toBe(true)
    expect(await gitIn(['rev-parse', '--abbrev-ref', 'HEAD'], data.path)).toBe(
      'test/fix-login',
    )
  })

  it('includes a Jira key in the branch and directory names', async () => {
    const result = await runCli(
      ['new', 'demo', '--title', 'fix login', '--jira', 'ABC-123', '--json'],
      sandbox,
    )
    const data = result.json<{ path: string; branch: string }>()
    expect(data.branch).toBe('test/ABC-123-fix-login')
    expect(data.path).toMatch(/-fix-login-ABC-123$/)
  })

  it('infers a Jira key present in the title', async () => {
    const result = await runCli(
      ['new', 'demo', '--title', 'ABC-9 fix login', '--json'],
      sandbox,
    )
    const data = result.json<{ branch: string }>()
    expect(data.branch).toBe('test/ABC-9-fix-login')
  })

  it('fails with needs_input when the title is missing', async () => {
    const result = await runCli(['new', 'demo', '--json'], sandbox)
    expect(result.exitCode).toBe(2)
    const data = result.json<{ ok: boolean; error: { code: string } }>()
    expect(data.ok).toBe(false)
    expect(data.error.code).toBe('needs_input')
  })

  it('refuses when the branch is already checked out elsewhere', async () => {
    await runCli(['new', 'demo', '--title', 'dup', '--json'], sandbox)
    const second = await runCli(
      ['new', 'demo', '--title', 'dup', '--dir', 'other', '--json'],
      sandbox,
    )
    expect(second.exitCode).toBe(1)
    expect(second.json<{ error: { code: string } }>().error.code).toBe(
      'branch_in_use',
    )
  })

  it('refuses to reuse a branch that exists but is not checked out', async () => {
    const created = await runCli(
      ['new', 'demo', '--title', 'dup2', '--json'],
      sandbox,
    )
    const path = created.json<{ path: string }>().path
    // Remove the worktree but keep the branch behind.
    await runCli(['cleanup', 'demo', path, '--yes', '--no-trash', '--json'], sandbox)

    const second = await runCli(
      ['new', 'demo', '--title', 'dup2', '--json'],
      sandbox,
    )
    expect(second.exitCode).toBe(1)
    expect(second.json<{ error: { code: string } }>().error.code).toBe(
      'branch_exists',
    )
  })

  it('treats values after -- as literal, not as global flags', async () => {
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

  it('reports unknown repos clearly', async () => {
    const result = await runCli(
      ['new', 'nope', '--title', 'x', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(1)
    expect(result.json<{ error: { code: string } }>().error.code).toBe(
      'unknown_repo',
    )
  })

  it('runs repo-defined setup commands in the new worktree', async () => {
    // Read from the repo root (the `main` checkout), which is where the file
    // is committed — not the parent directory, which is not version
    // controlled and so could never hold a committed config.
    await writeFile(
      join(sandbox.mainPath, 'worktree.json'),
      JSON.stringify({ 'setup-worktree': ['echo hi > setup-ran.txt'] }),
    )
    const result = await runCli(
      ['new', 'demo', '--title', 'with setup', '--json'],
      sandbox,
    )
    const data = result.json<{ path: string }>()
    expect(existsSync(join(data.path, 'setup-ran.txt'))).toBe(true)
  })

  it('ignores a config in the worktree parent directory', async () => {
    await writeFile(
      join(sandbox.repoPath, 'worktree.json'),
      JSON.stringify({ 'setup-worktree': ['echo hi > setup-ran.txt'] }),
    )
    const result = await runCli(
      ['new', 'demo', '--title', 'parent config', '--json'],
      sandbox,
    )
    const data = result.json<{ path: string }>()
    expect(existsSync(join(data.path, 'setup-ran.txt'))).toBe(false)
  })

  it('skips setup commands with --no-setup', async () => {
    await writeFile(
      join(sandbox.mainPath, 'worktree.json'),
      JSON.stringify({ 'setup-worktree': ['echo hi > setup-ran.txt'] }),
    )
    const result = await runCli(
      ['new', 'demo', '--title', 'no setup', '--no-setup', '--json'],
      sandbox,
    )
    const data = result.json<{ path: string }>()
    expect(existsSync(join(data.path, 'setup-ran.txt'))).toBe(false)
  })
})

describe('wt new --on (stacking)', () => {
  it('bases the branch on the parent worktree and records the parent', async () => {
    const first = await runCli(
      ['new', 'demo', '--title', 'base work', '--json'],
      sandbox,
    )
    const base = first.json<{ path: string; branch: string }>()

    // Commit on the parent so the stack has something to build on.
    await writeFile(join(base.path, 'feature.txt'), 'work\n')
    await gitIn(['add', '.'], base.path)
    await gitIn(['commit', '-m', 'parent work'], base.path)
    const parentSha = await gitIn(['rev-parse', 'HEAD'], base.path)

    const second = await runCli(
      ['new', 'demo', '--title', 'follow up', '--on', base.branch, '--json'],
      sandbox,
    )
    const stacked = second.json<{
      path: string
      branch: string
      base: string
      parent: string
    }>()

    expect(stacked.parent).toBe(base.branch)
    expect(stacked.base).toBe(base.branch)
    // The stacked worktree starts at the parent's tip, so it sees its file.
    expect(await gitIn(['rev-parse', 'HEAD'], stacked.path)).toBe(parentSha)
    expect(existsSync(join(stacked.path, 'feature.txt'))).toBe(true)
  })

  it('accepts a worktree directory name for --on', async () => {
    const first = await runCli(
      ['new', 'demo', '--title', 'base work', '--json'],
      sandbox,
    )
    const base = first.json<{ path: string; branch: string }>()
    const dirName = base.path.split('/').pop()!

    const second = await runCli(
      ['new', 'demo', '--title', 'follow up', '--on', dirName, '--json'],
      sandbox,
    )
    expect(second.json<{ parent: string }>().parent).toBe(base.branch)
  })

  it('surfaces the recorded parent in wt list', async () => {
    const first = await runCli(
      ['new', 'demo', '--title', 'base work', '--json'],
      sandbox,
    )
    const base = first.json<{ branch: string }>()
    const second = await runCli(
      ['new', 'demo', '--title', 'follow up', '--on', base.branch, '--json'],
      sandbox,
    )
    const stacked = second.json<{ branch: string }>()

    const list = await runCli(['list', 'demo', '--json'], sandbox)
    const data = list.json<{
      worktrees: { branch: string | null; parent: string | null }[]
    }>()
    const entry = data.worktrees.find((wt) => wt.branch === stacked.branch)
    expect(entry?.parent).toBe(base.branch)
  })

  it('errors when --on cannot be resolved', async () => {
    const result = await runCli(
      ['new', 'demo', '--title', 'x', '--on', 'no-such-thing', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(1)
    expect(result.json<{ error: { code: string } }>().error.code).toBe(
      'unknown_stack_parent',
    )
  })
})

describe('wt checkout', () => {
  it('checks out an existing remote branch into a new worktree', async () => {
    // Publish a branch to the remote from an independent clone.
    const helper = join(sandbox.root, 'helper')
    await mkdir(helper, { recursive: true })
    await gitIn(['clone', sandbox.remote, helper], sandbox.root)
    await gitIn(['config', 'user.email', 't@e.com'], helper)
    await gitIn(['config', 'user.name', 'T'], helper)
    await gitIn(['checkout', '-b', 'colleague/feature'], helper)
    await writeFile(join(helper, 'theirs.txt'), 'x\n')
    await gitIn(['add', '.'], helper)
    await gitIn(['commit', '-m', 'their work'], helper)
    await gitIn(['push', '-u', 'origin', 'colleague/feature'], helper)

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

  it('sets upstream tracking for a remote branch', async () => {
    const helper = join(sandbox.root, 'helper2')
    await mkdir(helper, { recursive: true })
    await gitIn(['clone', sandbox.remote, helper], sandbox.root)
    await gitIn(['config', 'user.email', 't@e.com'], helper)
    await gitIn(['config', 'user.name', 'T'], helper)
    await gitIn(['checkout', '-b', 'tracked'], helper)
    await gitIn(['commit', '--allow-empty', '-m', 'x'], helper)
    await gitIn(['push', '-u', 'origin', 'tracked'], helper)

    const result = await runCli(['checkout', 'demo', 'tracked', '--json'], sandbox)
    const data = result.json<{ path: string }>()
    const upstream = await gitIn(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      data.path,
    )
    expect(upstream).toBe('origin/tracked')
  })

  it('fails for an unknown branch without --create', async () => {
    const result = await runCli(['checkout', 'demo', 'ghost', '--json'], sandbox)
    expect(result.exitCode).toBe(1)
    expect(result.json<{ error: { code: string } }>().error.code).toBe(
      'branch_not_found',
    )
  })

  it('creates the branch with --create', async () => {
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

  it('returns the existing path when the branch is already checked out', async () => {
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

  it('needs a branch argument in non-interactive mode', async () => {
    const result = await runCli(['checkout', 'demo', '--json'], sandbox)
    expect(result.exitCode).toBe(2)
    expect(result.json<{ error: { code: string } }>().error.code).toBe(
      'needs_input',
    )
  })
})

describe('wt list', () => {
  it('marks the main worktree and reports dirty state', async () => {
    const created = await runCli(
      ['new', 'demo', '--title', 'dirty work', '--json'],
      sandbox,
    )
    const path = created.json<{ path: string }>().path
    await writeFile(join(path, 'scratch.txt'), 'uncommitted\n')

    const result = await runCli(['list', 'demo', '--json'], sandbox)
    const data = result.json<{
      worktrees: { path: string; isMain: boolean; dirty: boolean }[]
    }>()
    expect(data.worktrees[0]?.isMain).toBe(true)
    const entry = data.worktrees.find((wt) => wt.path === path)
    expect(entry?.dirty).toBe(true)
  })
})

describe('wt sync', () => {
  it('fast-forwards main when new commits land upstream', async () => {
    const helper = join(sandbox.root, 'pusher')
    await mkdir(helper, { recursive: true })
    await gitIn(['clone', sandbox.remote, helper], sandbox.root)
    await gitIn(['config', 'user.email', 't@e.com'], helper)
    await gitIn(['config', 'user.name', 'T'], helper)
    await writeFile(join(helper, 'new.txt'), 'new\n')
    await gitIn(['add', '.'], helper)
    await gitIn(['commit', '-m', 'upstream work'], helper)
    await gitIn(['push'], helper)

    const before = await gitIn(['rev-parse', 'HEAD'], sandbox.mainPath)
    const result = await runCli(['sync', 'demo', '--json'], sandbox)
    expect(result.exitCode).toBe(0)
    const data = result.json<{
      results: { updated: boolean; skipped: string | null }[]
    }>()
    expect(data.results[0]?.updated).toBe(true)
    expect(data.results[0]?.skipped).toBeNull()

    const after = await gitIn(['rev-parse', 'HEAD'], sandbox.mainPath)
    expect(after).not.toBe(before)
    expect(existsSync(join(sandbox.mainPath, 'new.txt'))).toBe(true)
  })

  it('reports no-op when already current', async () => {
    const result = await runCli(['sync', 'demo', '--json'], sandbox)
    const data = result.json<{ results: { updated: boolean }[] }>()
    expect(data.results[0]?.updated).toBe(false)
  })

  it('refuses to touch a dirty main checkout', async () => {
    await writeFile(join(sandbox.mainPath, 'local.txt'), 'wip\n')
    const result = await runCli(['sync', 'demo', '--json'], sandbox)
    const data = result.json<{ results: { skipped: string | null }[] }>()
    expect(data.results[0]?.skipped).toMatch(/uncommitted changes/)
  })
})

describe('wt cleanup', () => {
  it('removes a clean worktree', async () => {
    const created = await runCli(
      ['new', 'demo', '--title', 'disposable', '--json'],
      sandbox,
    )
    const path = created.json<{ path: string }>().path

    const result = await runCli(
      ['cleanup', 'demo', path, '--yes', '--no-trash', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{ removed: { removed: boolean }[] }>()
    expect(data.removed[0]?.removed).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('skips a dirty worktree unless forced', async () => {
    const created = await runCli(
      ['new', 'demo', '--title', 'has work', '--json'],
      sandbox,
    )
    const path = created.json<{ path: string }>().path
    await writeFile(join(path, 'wip.txt'), 'important\n')

    const result = await runCli(
      ['cleanup', 'demo', path, '--yes', '--no-trash', '--json'],
      sandbox,
    )
    const data = result.json<{ removed: { skipped: string | null }[] }>()
    expect(data.removed[0]?.skipped).toMatch(/--force/)
    expect(existsSync(path)).toBe(true)
  })

  it('removes a dirty worktree with --force', async () => {
    const created = await runCli(
      ['new', 'demo', '--title', 'force me', '--json'],
      sandbox,
    )
    const path = created.json<{ path: string }>().path
    await writeFile(join(path, 'wip.txt'), 'disposable\n')

    const result = await runCli(
      ['cleanup', 'demo', path, '--force', '--no-trash', '--json'],
      sandbox,
    )
    expect(result.json<{ removed: { removed: boolean }[] }>().removed[0]?.removed).toBe(
      true,
    )
    expect(existsSync(path)).toBe(false)
  })

  it('reports without removing under --dry-run', async () => {
    const created = await runCli(
      ['new', 'demo', '--title', 'keep me', '--json'],
      sandbox,
    )
    const path = created.json<{ path: string }>().path

    const result = await runCli(
      ['cleanup', 'demo', path, '--dry-run', '--json'],
      sandbox,
    )
    const data = result.json<{ dryRun: boolean; wouldRemove: unknown[] }>()
    expect(data.dryRun).toBe(true)
    expect(data.wouldRemove).toHaveLength(1)
    expect(existsSync(path)).toBe(true)
  })

  it('moves the worktree to the trash and prunes the registration', async () => {
    const created = await runCli(
      ['new', 'demo', '--title', 'trash me', '--json'],
      sandbox,
    )
    const path = created.json<{ path: string }>().path

    // Point the trash at a directory we control so the test stays hermetic.
    const trashDir = join(sandbox.root, 'trash')
    await mkdir(trashDir, { recursive: true })
    const result = await runCli(
      ['cleanup', 'demo', path, '--yes', '--json'],
      sandbox,
      { GROVE_TRASH_DIR: trashDir },
    )

    const data = result.json<{ removed: { removed: boolean; trashed: boolean }[] }>()
    expect(data.removed[0]?.removed).toBe(true)
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

  it('deletes the branch with --delete-branch', async () => {
    const created = await runCli(
      ['new', 'demo', '--title', 'branch gone', '--json'],
      sandbox,
    )
    const { path, branch } = created.json<{ path: string; branch: string }>()

    await runCli(
      ['cleanup', 'demo', path, '--yes', '--delete-branch', '--no-trash', '--json'],
      sandbox,
    )
    const branches = await gitIn(['branch', '--list', branch], sandbox.mainPath)
    expect(branches).toBe('')
  })
})

describe('wt skills install', () => {
  it('installs skill files into the target directory', async () => {
    const target = join(sandbox.root, 'skills-target')
    const result = await runCli(
      ['skills', 'install', '--target', target, '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<{ installed: string[] }>()
    expect(data.installed.sort()).toEqual(['wt-repos', 'wt-worktree'])
    expect(existsSync(join(target, 'wt-repos', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(target, 'wt-worktree', 'SKILL.md'))).toBe(true)
  })

  it('skips existing skills unless --force is passed', async () => {
    const target = join(sandbox.root, 'skills-target')
    await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    const again = await runCli(
      ['skills', 'install', '--target', target, '--json'],
      sandbox,
    )
    const data = again.json<{ installed: string[]; skipped: string[] }>()
    expect(data.installed).toEqual([])
    expect(data.skipped.sort()).toEqual(['wt-repos', 'wt-worktree'])
  })

  it('overwrites with --force', async () => {
    const target = join(sandbox.root, 'skills-target')
    await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    const file = join(target, 'wt-repos', 'SKILL.md')
    await writeFile(file, 'clobbered\n')

    await runCli(
      ['skills', 'install', '--target', target, '--force', '--json'],
      sandbox,
    )
    expect(await readFile(file, 'utf8')).not.toBe('clobbered\n')
  })

  it('writes skills with valid frontmatter', async () => {
    const target = join(sandbox.root, 'skills-target')
    await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    const content = await readFile(join(target, 'wt-worktree', 'SKILL.md'), 'utf8')
    expect(content).toMatch(/^---\nname: wt-worktree\ndescription: .+/m)
  })
})

describe('shell integration', () => {
  it('emits a cd sentinel only when the wrapper is active', async () => {
    const created = await runCli(
      ['new', 'demo', '--title', 'cd target', '--json'],
      sandbox,
    )
    const path = created.json<{ path: string }>().path

    const withWrapper = await runCli(['pick', 'demo', path], sandbox, {
      GROVE_SHELL_INTEGRATION: '1',
    })
    expect(withWrapper.stdout.trim()).toBe(`__WT_CD__${path}`)

    const withoutWrapper = await runCli(['pick', 'demo', path], sandbox)
    expect(withoutWrapper.stdout.trim()).toBe(path)
  })

  it('generates a zsh function that handles the sentinel', async () => {
    const result = await runCli(['shell-init', 'zsh'], sandbox)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('wt()')
    expect(result.stdout).toContain('__WT_CD__')
    expect(result.stdout).toContain('command grove')
  })

  it('supports fish and powershell', async () => {
    const fish = await runCli(['shell-init', 'fish'], sandbox)
    expect(fish.stdout).toContain('function wt')
    const pwsh = await runCli(['shell-init', 'powershell'], sandbox)
    expect(pwsh.stdout).toContain('Set-Location')
  })
})

describe('grove __complete', () => {
  it('lists repos as value/description pairs', async () => {
    const result = await runCli(['__complete', 'repos'], sandbox)
    expect(result.exitCode).toBe(0)
    const [name, description] = result.stdout.trim().split('\t')
    expect(name).toBe('demo')
    expect(description).toBe(sandbox.repoPath)
  })

  it('lists worktrees for a repo', async () => {
    await runCli(['new', 'demo', '--title', 'completion target', '--json'], sandbox)
    const result = await runCli(['__complete', 'worktrees', 'demo'], sandbox)
    const dirs = result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('\t')[0])
    expect(dirs).toContain('main')
    expect(dirs).toContain('260810-completion-target')
  })

  it('lists branches and flags those already checked out', async () => {
    await runCli(['new', 'demo', '--title', 'on a branch', '--json'], sandbox)
    const result = await runCli(['__complete', 'branches', 'demo'], sandbox)
    const rows = result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('\t'))
    const checked = rows.find((row) => row[0] === 'test/on-a-branch')
    expect(checked?.[1]).toBe('already checked out')
    expect(rows.map((row) => row[0])).toContain('main')
  })

  it('stays silent and succeeds for an unknown repo', async () => {
    const result = await runCli(['__complete', 'worktrees', 'nope'], sandbox)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it('stays silent for an unknown category', async () => {
    const result = await runCli(['__complete', 'nonsense'], sandbox)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })
})

describe('grove profile', () => {
  it('adds a profile and reports it as JSON', async () => {
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

  it('uses the only profile when just one is configured', async () => {
    const workDir = join(sandbox.root, 'work')
    await runCli(['profile', 'add', 'work', workDir, '--json'], sandbox)
    const result = await runCli(
      ['clone', sandbox.remote, 'routed', '--no-alias', '--json'],
      sandbox,
    )
    const data = result.json<{ profile: string; path: string }>()
    expect(data.profile).toBe('work')
    expect(data.path).toBe(join(workDir, 'routed'))
  })

  it('honours an explicit --profile over the default', async () => {
    const ossDir = join(sandbox.root, 'oss')
    await runCli(['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'], sandbox)
    await runCli(['profile', 'add', 'oss', ossDir, '--json'], sandbox)

    const result = await runCli(
      ['clone', sandbox.remote, 'chosen', '--profile', 'oss', '--no-alias', '--json'],
      sandbox,
    )
    expect(result.json<{ path: string }>().path).toBe(join(ossDir, 'chosen'))
  })

  it('requires a profile when several exist and no default is set', async () => {
    await runCli(['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'], sandbox)
    await runCli(['profile', 'add', 'oss', join(sandbox.root, 'oss'), '--json'], sandbox)

    const result = await runCli(
      ['clone', sandbox.remote, 'ambiguous', '--no-alias', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(2)
    const error = result.json<{ error: { code: string; hint: string } }>().error
    expect(error.code).toBe('needs_input')
    expect(error.hint).toContain('--profile')
  })

  it('uses the default profile when set', async () => {
    const ossDir = join(sandbox.root, 'oss')
    await runCli(['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'], sandbox)
    await runCli(['profile', 'add', 'oss', ossDir, '--default', '--json'], sandbox)

    const result = await runCli(
      ['clone', sandbox.remote, 'defaulted', '--no-alias', '--json'],
      sandbox,
    )
    expect(result.json<{ profile: string }>().profile).toBe('oss')
  })

  it('sets, shows, and clears the default with `profile default`', async () => {
    const ossDir = join(sandbox.root, 'oss')
    await runCli(['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'], sandbox)
    await runCli(['profile', 'add', 'oss', ossDir, '--json'], sandbox)

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

  it('rejects an unknown profile as the default', async () => {
    await runCli(['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'], sandbox)
    const result = await runCli(['profile', 'default', 'nope', '--json'], sandbox)
    expect(result.exitCode).toBe(1)
    expect(result.json<{ error: { code: string } }>().error.code).toBe(
      'unknown_profile',
    )
  })

  it('clears the default when that profile is removed', async () => {
    await runCli(['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'], sandbox)
    await runCli(['profile', 'add', 'oss', join(sandbox.root, 'oss'), '--json'], sandbox)
    await runCli(['profile', 'default', 'oss', '--json'], sandbox)

    await runCli(['profile', 'remove', 'oss', '--json'], sandbox)
    const after = await runCli(['profile', 'default', '--json'], sandbox)
    expect(after.json<{ defaultProfile: string | null }>().defaultProfile).toBeNull()
  })
})

describe('registry aliases', () => {
  it('refuses an alias that collides with an existing repo name', async () => {
    // Names and aliases share one namespace, so accepting this would delete
    // the existing repo's registration.
    const other = join(sandbox.root, 'code', 'other')
    await mkdir(other, { recursive: true })
    await runCli(['repos', 'add', sandbox.repoPath, '--name', 'keepme', '--json'], sandbox)

    const result = await runCli(
      ['repos', 'add', sandbox.repoPath, '--name', 'newrepo', '--alias', 'keepme', '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(1)
    expect(result.json<{ error: { code: string } }>().error.code).toBe(
      'alias_conflicts_with_repo',
    )

    // The existing repo survived.
    const repos = await runCli(['repos', '--json'], sandbox)
    const names = repos.json<{ repos: { name: string }[] }>().repos.map((r) => r.name)
    expect(names).toContain('keepme')
  })
})

describe('grove profile add writes config immediately', () => {
  it('writes git and Claude config without a separate apply step', async () => {
    const workDir = join(sandbox.root, 'work')
    const result = await runCli(
      ['profile', 'add', 'work', workDir, '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)

    // The files exist straight away — no `profile apply` was run.
    const profileConfig = await readFile(join(workDir, '.gitconfig'), 'utf8')
    expect(profileConfig).toContain('# Profile: work')

    const globalConfig = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')
    expect(globalConfig).toContain(`[includeIf "gitdir:${workDir}/"]`)

    const settings = JSON.parse(
      await readFile(join(sandbox.root, '.claude', 'settings.json'), 'utf8'),
    ) as { permissions: { additionalDirectories: string[] } }
    expect(settings.permissions.additionalDirectories).toContain(workDir)

    // And the response reports exactly which files it touched.
    const wrote = result.json<{ wrote: string[] }>().wrote
    expect(wrote).toContain(join(workDir, '.gitconfig'))
    expect(wrote).toContain(join(sandbox.root, '.claude', 'settings.json'))
  })

  it('leaves config alone with --no-apply', async () => {
    const workDir = join(sandbox.root, 'work')
    const result = await runCli(
      ['profile', 'add', 'work', workDir, '--no-apply', '--json'],
      sandbox,
    )
    expect(result.json<{ wrote: string[] }>().wrote).toEqual([])
    expect(existsSync(join(workDir, '.gitconfig'))).toBe(false)
    expect(existsSync(join(sandbox.root, '.claude', 'settings.json'))).toBe(false)

    // A later apply still picks it up.
    await runCli(['profile', 'apply', '--yes', '--json'], sandbox)
    expect(existsSync(join(workDir, '.gitconfig'))).toBe(true)
  })

  it('a follow-up apply reports nothing left to do', async () => {
    await runCli(
      ['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'],
      sandbox,
    )
    const apply = await runCli(['profile', 'apply', '--yes', '--json'], sandbox)
    const changes = apply.json<{ changes: { changed: boolean }[] }>().changes
    expect(changes.every((change) => !change.changed)).toBe(true)
  })

  it('removing a profile drops its includeIf stanza', async () => {
    const workDir = join(sandbox.root, 'work')
    const ossDir = join(sandbox.root, 'oss')
    await runCli(['profile', 'add', 'work', workDir, '--json'], sandbox)
    await runCli(['profile', 'add', 'oss', ossDir, '--json'], sandbox)
    expect(await readFile(join(sandbox.root, '.gitconfig'), 'utf8')).toContain(
      `gitdir:${workDir}/`,
    )

    await runCli(['profile', 'remove', 'work', '--json'], sandbox)
    const after = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')
    expect(after).not.toContain(`gitdir:${workDir}/`)
    // The surviving profile keeps its stanza.
    expect(after).toContain(`gitdir:${ossDir}/`)
  })

  it('removing a profile strips the managed block but keeps hand-written config', async () => {
    const workDir = join(sandbox.root, 'work')
    await runCli(['profile', 'add', 'work', workDir, '--json'], sandbox)

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

  it('removing the last profile clears the managed block entirely', async () => {
    const workDir = join(sandbox.root, 'work')
    await writeFile(join(sandbox.root, '.gitconfig'), '[user]\n\tname = Someone\n')
    await runCli(['profile', 'add', 'work', workDir, '--json'], sandbox)

    await runCli(['profile', 'remove', 'work', '--json'], sandbox)
    const after = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')

    expect(after).not.toContain('grove managed')
    expect(after).not.toContain('includeIf')
    // Hand-written config is untouched.
    expect(after).toContain('name = Someone')
  })
})

describe('grove profile apply', () => {
  it('writes the per-profile gitconfig and Claude read permissions', async () => {
    const workDir = join(sandbox.root, 'work')
    await runCli(['profile', 'add', 'work', workDir, '--json'], sandbox)
    const result = await runCli(['profile', 'apply', '--yes', '--json'], sandbox)
    expect(result.exitCode).toBe(0)

    // Per-profile gitconfig exists, ready for the user's own settings.
    const profileConfig = await readFile(join(workDir, '.gitconfig'), 'utf8')
    expect(profileConfig).toContain('# Profile: work')

    // Global gitconfig includes it only for paths under the profile dir.
    const globalConfig = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')
    expect(globalConfig).toContain(`[includeIf "gitdir:${workDir}/"]`)

    // Claude gains read access to the profile directory.
    const settings = JSON.parse(
      await readFile(join(sandbox.root, '.claude', 'settings.json'), 'utf8'),
    ) as { permissions: { additionalDirectories: string[]; allow: string[] } }
    expect(settings.permissions.additionalDirectories).toContain(workDir)
    expect(settings.permissions.allow).toContain(`Read(${workDir}/**)`)
  })

  it('preserves existing Claude settings', async () => {
    await mkdir(join(sandbox.root, '.claude'), { recursive: true })
    await writeFile(
      join(sandbox.root, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(ls:*)'], defaultMode: 'auto' },
      }),
    )
    await runCli(['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'], sandbox)
    await runCli(['profile', 'apply', '--yes', '--json'], sandbox)

    const settings = JSON.parse(
      await readFile(join(sandbox.root, '.claude', 'settings.json'), 'utf8'),
    ) as {
      model: string
      permissions: { allow: string[]; defaultMode: string }
    }
    expect(settings.model).toBe('opus')
    expect(settings.permissions.defaultMode).toBe('auto')
    expect(settings.permissions.allow).toContain('Bash(ls:*)')
  })

  it('is idempotent and does not duplicate managed blocks', async () => {
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

  it('preserves unmanaged content in the global gitconfig', async () => {
    await writeFile(
      join(sandbox.root, '.gitconfig'),
      '[user]\n\tname = Someone\n\temail = someone@example.com\n',
    )
    await runCli(['profile', 'add', 'work', join(sandbox.root, 'work'), '--json'], sandbox)
    await runCli(['profile', 'apply', '--yes', '--json'], sandbox)

    const config = await readFile(join(sandbox.root, '.gitconfig'), 'utf8')
    expect(config).toContain('name = Someone')
    expect(config).toContain('includeIf')
  })

  it('does not grant read access to a default dir holding no repos', async () => {
    // The sandbox registry lives under <root>/code, and the demo repo is
    // there, so <root>/code is legitimately included; a profile elsewhere
    // must not drag in unrelated directories.
    const workDir = join(sandbox.root, 'work')
    await runCli(['profile', 'add', 'work', workDir, '--json'], sandbox)
    await runCli(['profile', 'apply', '--yes', '--json'], sandbox)

    const settings = JSON.parse(
      await readFile(join(sandbox.root, '.claude', 'settings.json'), 'utf8'),
    ) as { permissions: { additionalDirectories: string[] } }
    const dirs = settings.permissions.additionalDirectories

    expect(dirs).toContain(workDir)
    // No entry may be nested inside another; that would be redundant scope.
    for (const dir of dirs) {
      const nested = dirs.filter((other) => other !== dir && dir.startsWith(`${other}/`))
      expect(nested).toEqual([])
    }
  })

  it('reports changes without writing under --dry-run', async () => {
    // --no-apply keeps `add` from writing, so --dry-run has pending work to
    // report and we can prove it writes nothing.
    const workDir = join(sandbox.root, 'work')
    await runCli(['profile', 'add', 'work', workDir, '--no-apply', '--json'], sandbox)

    const result = await runCli(['profile', 'apply', '--dry-run', '--json'], sandbox)
    const data = result.json<{ dryRun: boolean; changes: { changed: boolean }[] }>()

    expect(data.dryRun).toBe(true)
    expect(data.changes.some((change) => change.changed)).toBe(true)
    expect(existsSync(join(sandbox.root, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(workDir, '.gitconfig'))).toBe(false)
  })

  it('the generated includeIf actually engages for repos in the profile', async () => {
    // The real proof: git must load the per-profile config, not merely have
    // it written. git matches `gitdir:` against the realpath, so a profile
    // dir stored uncanonicalised would silently never match.
    const workDir = join(sandbox.root, 'work')
    await runCli(['profile', 'add', 'work', workDir, '--json'], sandbox)
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

describe('wt pick', () => {
  it('resolves a unique substring match', async () => {
    const created = await runCli(
      ['new', 'demo', '--title', 'unique name here', '--json'],
      sandbox,
    )
    const path = created.json<{ path: string }>().path

    const result = await runCli(['pick', 'demo', 'unique', '--json'], sandbox)
    expect(result.json<{ path: string }>().path).toBe(path)
  })

  it('errors on an ambiguous match', async () => {
    await runCli(['new', 'demo', '--title', 'shared alpha', '--json'], sandbox)
    await runCli(['new', 'demo', '--title', 'shared beta', '--json'], sandbox)

    const result = await runCli(['pick', 'demo', 'shared', '--json'], sandbox)
    expect(result.exitCode).toBe(1)
    expect(result.json<{ error: { code: string } }>().error.code).toBe(
      'ambiguous_worktree',
    )
  })

  it('jumps to main with --main', async () => {
    const result = await runCli(['pick', 'demo', '--main', '--json'], sandbox)
    expect(result.json<{ path: string }>().path).toBe(sandbox.mainPath)
  })
})
