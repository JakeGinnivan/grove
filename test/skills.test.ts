import { describe, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  runCli,
} from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'

interface InstallTargets {
  targets: { target: string; dir: string; installed: string[]; skipped: string[] }[]
}

describe('wt skills install', () => {
  it('installs skill files into the target directory', async ({ sandbox }) => {
    const target = join(sandbox.root, 'skills-target')
    const result = await runCli(
      ['skills', 'install', '--target', target, '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<InstallTargets>()
    expect(data.targets).toHaveLength(1)
    expect(data.targets[0]!.installed.sort()).toEqual([
      'wt-repos',
      'wt-tidy',
      'wt-worktree',
    ])
    expect(existsSync(join(target, 'wt-repos', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(target, 'wt-tidy', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(target, 'wt-worktree', 'SKILL.md'))).toBe(true)
  })

  it('installs into several targets at once', async ({ sandbox }) => {
    const a = join(sandbox.root, 'target-a')
    const b = join(sandbox.root, 'target-b')
    const result = await runCli(
      ['skills', 'install', '--target', a, b, '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    expect(result.json<InstallTargets>().targets).toHaveLength(2)
    expect(existsSync(join(a, 'wt-repos', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(b, 'wt-repos', 'SKILL.md'))).toBe(true)
  })

  it('detects installed agent tools when no target is given', async ({ sandbox }) => {
    // HOME is the sandbox, so these are the only "installed" tools.
    await mkdir(join(sandbox.root, '.claude'), { recursive: true })
    await mkdir(join(sandbox.root, '.gemini'), { recursive: true })

    const result = await runCli(['skills', 'install', '--json'], sandbox)
    expect(result.exitCode).toBe(0)
    const names = result.json<InstallTargets>().targets.map((t) => t.target)
    expect(names.sort()).toEqual(['claude', 'gemini'])

    // Each tool gets its own copy, in its own conventional location.
    expect(
      existsSync(join(sandbox.root, '.claude', 'skills', 'wt-repos', 'SKILL.md')),
    ).toBe(true)
    expect(
      existsSync(join(sandbox.root, '.gemini', 'skills', 'wt-repos', 'SKILL.md')),
    ).toBe(true)
  })

  it('fails clearly when no agent tools are detected', async ({ sandbox }) => {
    const result = await runCli(['skills', 'install', '--json'], sandbox)
    expect(result.exitCode).toBe(1)
    expect(result.json<{ error: { code: string } }>().error.code).toBe(
      'no_agent_tools',
    )
  })

  it('skips existing skills unless --force is passed', async ({ sandbox }) => {
    const target = join(sandbox.root, 'skills-target')
    await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    const again = await runCli(
      ['skills', 'install', '--target', target, '--json'],
      sandbox,
    )
    const data = again.json<InstallTargets>().targets[0]!
    expect(data.installed).toEqual([])
    expect(data.skipped.sort()).toEqual(['wt-repos', 'wt-tidy', 'wt-worktree'])
  })

  it('overwrites with --force', async ({ sandbox }) => {
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

  it('writes skills with valid frontmatter', async ({ sandbox }) => {
    const target = join(sandbox.root, 'skills-target')
    await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    for (const name of ['wt-repos', 'wt-tidy', 'wt-worktree']) {
      const content = await readFile(join(target, name, 'SKILL.md'), 'utf8')
      // git may check the template out with CRLF endings on Windows.
      expect(content.replace(/\r\n/g, '\n')).toMatch(
        new RegExp(`^---\\nname: ${name}\\ndescription: .+`, 'm'),
      )
    }
  })
})
