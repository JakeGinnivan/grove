import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSandbox, runCli, type Sandbox } from './helpers/sandbox.js'
import { AUTO_MODE_HINTS } from '../src/core/claude-settings.js'

// Every case runs the CLI with HOME redirected to the sandbox, so
// ~/.claude/settings.json below is the sandbox's copy. Each case also asserts
// the reported path is inside the sandbox, so a regression that resolved the
// real home directory fails here rather than editing the developer's settings.

let sandbox: Sandbox
let settingsPath: string

beforeEach(async () => {
  sandbox = await createSandbox()
  await mkdir(join(sandbox.root, '.claude'), { recursive: true })
  settingsPath = join(sandbox.root, '.claude', 'settings.json')
})

afterEach(async () => {
  await sandbox.cleanup()
})

interface InstallResult {
  claudeAutoMode: { status: string; path?: string; reason?: string } | null
}

async function install(...flags: string[]) {
  const result = await runCli(
    ['skills', 'install', '--target', 'claude', '--json', ...flags],
    sandbox,
  )
  expect(result.exitCode).toBe(0)
  const outcome = result.json<InstallResult>().claudeAutoMode
  if (outcome?.path) expect(outcome.path).toBe(settingsPath)
  return outcome
}

async function readSettings() {
  return JSON.parse(await readFile(settingsPath, 'utf8')) as {
    autoMode: Record<string, string[]>
    [key: string]: unknown
  }
}

const [environmentHint, allowHint] = AUTO_MODE_HINTS

describe('skills install --claude-auto-mode', () => {
  it('reports its target inside the sandboxed HOME', async () => {
    const outcome = await install('--claude-auto-mode')
    expect(outcome?.path?.startsWith(sandbox.root)).toBe(true)
  })

  it('creates the settings with $defaults kept in each list', async () => {
    expect((await install('--claude-auto-mode'))?.status).toBe('added')

    const { autoMode } = await readSettings()
    // A list without $defaults would replace Claude Code's built-in rules.
    expect(autoMode.environment).toEqual(['$defaults', environmentHint.text])
    expect(autoMode.allow).toEqual(['$defaults', allowHint.text])
    expect(autoMode.soft_deny).toBeUndefined()
  })

  it('keeps other settings and appends to existing lists as written', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          model: 'opus',
          permissions: { allow: ['Bash(ls)'] },
          autoMode: { allow: ['My own rule'] },
        },
        null,
        4,
      ) + '\n',
    )

    await install('--claude-auto-mode')

    const raw = await readFile(settingsPath, 'utf8')
    expect(raw).toMatch(/^\{\n {4}"model"/)
    const settings = await readSettings()
    expect(settings.model).toBe('opus')
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] })
    // The user dropped $defaults from this list; grove must not re-add it.
    expect(settings.autoMode.allow).toEqual(['My own rule', allowHint.text])
    expect(settings.autoMode.environment).toEqual(['$defaults', environmentHint.text])
  })

  it('is idempotent and rewords an older copy of a hint in place', async () => {
    await install('--claude-auto-mode')
    expect((await install('--claude-auto-mode'))?.status).toBe('present')

    const settings = await readSettings()
    settings.autoMode.allow = ['$defaults', `${allowHint.prefix} older wording`]
    await writeFile(settingsPath, JSON.stringify(settings, null, 2))

    expect((await install('--claude-auto-mode'))?.status).toBe('updated')
    expect((await readSettings()).autoMode.allow).toEqual(['$defaults', allowHint.text])
  })

  it.skipIf(process.platform === 'win32')(
    'writes through a symlinked settings file without replacing the link',
    async () => {
      const real = join(sandbox.root, 'dotfiles', 'settings.json')
      await mkdir(join(sandbox.root, 'dotfiles'))
      await writeFile(real, '{}\n')
      await symlink(real, settingsPath)

      await install('--claude-auto-mode')

      expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true)
      const target = JSON.parse(await readFile(real, 'utf8')) as InstallResult & {
        autoMode: Record<string, string[]>
      }
      expect(target.autoMode.allow).toContain(allowHint.text)
    },
  )

  it('leaves an unparseable settings file untouched', async () => {
    await writeFile(settingsPath, '{ not json')
    const outcome = await install('--claude-auto-mode')
    expect(outcome?.status).toBe('invalid')
    expect(await readFile(settingsPath, 'utf8')).toBe('{ not json')
  })

  it('changes nothing without the flag when it cannot prompt', async () => {
    expect((await install())?.status).toBe('not-requested')
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('changes nothing with --no-claude-auto-mode', async () => {
    expect((await install('--no-claude-auto-mode'))?.status).toBe('declined')
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('reports without writing under --dry-run', async () => {
    const result = await runCli(
      ['skills', 'install', '--target', 'claude', '--dry-run', '--claude-auto-mode', '--json'],
      sandbox,
    )
    expect(result.json<InstallResult>().claudeAutoMode?.status).toBe('added')
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('does not touch Claude settings when installing for other tools only', async () => {
    const result = await runCli(
      ['skills', 'install', '--target', 'gemini', '--claude-auto-mode', '--json'],
      sandbox,
    )
    expect(result.json<InstallResult>().claudeAutoMode).toBeNull()
    expect(existsSync(settingsPath)).toBe(false)
  })
})
