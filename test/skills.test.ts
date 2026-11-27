import { describe, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  runCli,
  type Sandbox,
} from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'
import { expectError } from './helpers/grove.js'

/**
 * Every skill grove ships, read from the templates so that a new skill is
 * covered here without editing this file, and one missing from the build's
 * copy list fails.
 */
const SKILLS = readdirSync(
  fileURLToPath(new URL('../src/skills/templates', import.meta.url)),
).sort()

interface InstallReport {
  target: string
  dir: string
  installed: string[]
  updated: string[]
  current: string[]
  skipped: string[]
}

interface InstallTargets {
  targets: InstallReport[]
}

const OLD_SKILL = '---\nname: wt-repos\ndescription: an older grove\n---\n'

/**
 * Make an installed skill look like an older grove wrote it: older content,
 * with the record matching that content.
 */
async function writeOlderSkill(sandbox: { root: string }, file: string): Promise<void> {
  await writeFile(file, OLD_SKILL)
  const statePath = join(sandbox.root, '.config', 'grove', 'skills.json')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    installed: Record<string, { hash: string }>
  }
  state.installed[file] = { hash: createHash('sha256').update(OLD_SKILL).digest('hex') }
  await writeFile(statePath, JSON.stringify(state))
}

describe('wt skills install', () => {
  it('installs every skill, with valid frontmatter, into the target directory', async ({ sandbox }) => {
    const target = join(sandbox.root, 'skills-target')
    const result = await runCli(
      ['skills', 'install', '--target', target, '--json'],
      sandbox,
    )
    expect(result.exitCode).toBe(0)
    const data = result.json<InstallTargets>()
    expect(data.targets).toHaveLength(1)
    expect(data.targets[0]!.installed.sort()).toEqual(SKILLS)
    for (const name of SKILLS) {
      const content = await readFile(join(target, name, 'SKILL.md'), 'utf8')
      // git may check the template out with CRLF endings on Windows.
      expect(content.replace(/\r\n/g, '\n')).toMatch(
        new RegExp(`^---\\nname: ${name}\\ndescription: .+`, 'm'),
      )
    }
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
    expectError(result, 'no_agent_tools')
  })

  it('reports skills that match this version as current', async ({ sandbox }) => {
    const target = join(sandbox.root, 'skills-target')
    await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    const again = await runCli(
      ['skills', 'install', '--target', target, '--json'],
      sandbox,
    )
    const data = again.json<InstallTargets>().targets[0]!
    expect(data.installed).toEqual([])
    expect(data.skipped).toEqual([])
    expect(data.current.sort()).toEqual(SKILLS)
  })

  it('updates a skill an older grove installed without --force', async ({ sandbox }) => {
    const target = join(sandbox.root, 'skills-target')
    await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    const file = join(target, 'wt-repos', 'SKILL.md')
    await writeOlderSkill(sandbox, file)

    const again = await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    expect(again.json<InstallTargets>().targets[0]!.updated).toEqual(['wt-repos'])
    expect(await readFile(file, 'utf8')).not.toBe(OLD_SKILL)
  })

  it('leaves a locally edited skill alone unless --force is passed', async ({ sandbox }) => {
    const target = join(sandbox.root, 'skills-target')
    await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    const file = join(target, 'wt-repos', 'SKILL.md')
    await writeFile(file, 'clobbered\n')

    const again = await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    expect(again.json<InstallTargets>().targets[0]!.skipped).toEqual(['wt-repos'])
    expect(await readFile(file, 'utf8')).toBe('clobbered\n')

    await runCli(
      ['skills', 'install', '--target', target, '--force', '--json'],
      sandbox,
    )
    expect(await readFile(file, 'utf8')).not.toBe('clobbered\n')
  })

  it('updates a differing skill installed before grove kept records', async ({ sandbox }) => {
    const target = join(sandbox.root, 'skills-target')
    const file = join(target, 'wt-repos', 'SKILL.md')
    await mkdir(join(target, 'wt-repos'), { recursive: true })
    await writeFile(file, OLD_SKILL)

    const result = await runCli(['skills', 'install', '--target', target, '--json'], sandbox)
    expect(result.json<InstallTargets>().targets[0]!.updated).toEqual(['wt-repos'])
  })
})

describe('wt skills install, once skills are installed', () => {
  async function installForClaude(sandbox: Sandbox) {
    await mkdir(join(sandbox.root, '.claude'), { recursive: true })
    await runCli(['skills', 'install', '--json', '--no-claude-auto-mode'], sandbox)
    return join(sandbox.root, '.claude', 'skills', 'wt-repos', 'SKILL.md')
  }

  it('updates only the tools that already have them', async ({ sandbox }) => {
    const file = await installForClaude(sandbox)
    await writeOlderSkill(sandbox, file)
    // Detected after the first install: named, but not installed into.
    await mkdir(join(sandbox.root, '.gemini'), { recursive: true })

    const result = await runCli(['skills', 'install', '--json'], sandbox)
    expect(result.exitCode).toBe(0)
    const data = result.json<InstallTargets & { notInstalled: string[] }>()
    expect(data.targets.map((report) => report.target)).toEqual(['claude'])
    expect(data.targets[0]!.updated).toEqual(['wt-repos'])
    expect(data.notInstalled).toEqual(['gemini'])
    expect(existsSync(join(sandbox.root, '.gemini', 'skills'))).toBe(false)
  })

  it('adds a skill this version introduced alongside the existing ones', async ({ sandbox }) => {
    await installForClaude(sandbox)
    await rm(join(sandbox.root, '.claude', 'skills', 'wt-tidy'), { recursive: true })

    const result = await runCli(['skills', 'install', '--json'], sandbox)
    expect(result.json<InstallTargets>().targets[0]!.installed).toEqual(['wt-tidy'])
  })

  it('does not ask about auto mode again', async ({ sandbox }) => {
    await installForClaude(sandbox)
    const result = await runCli(['skills', 'install', '--json'], sandbox)
    expect(result.json<{ claudeAutoMode: unknown }>().claudeAutoMode).toBeNull()
  })

  it('still installs into a tool named with --target', async ({ sandbox }) => {
    await installForClaude(sandbox)
    await mkdir(join(sandbox.root, '.gemini'), { recursive: true })
    const result = await runCli(['skills', 'install', '--target', 'gemini', '--json'], sandbox)
    expect(result.json<InstallTargets>().targets[0]!.installed.sort()).toEqual(SKILLS)
  })
})

describe('outdated skills warning', () => {
  const WARNING = "grove's agent skills are out of date for Claude Code"

  it('follows other commands until the skills are updated', async ({ sandbox }) => {
    await mkdir(join(sandbox.root, '.claude'), { recursive: true })
    await runCli(['skills', 'install', '--json', '--no-claude-auto-mode'], sandbox)
    const file = join(sandbox.root, '.claude', 'skills', 'wt-repos', 'SKILL.md')

    expect((await runCli(['repos'], sandbox)).stderr).not.toContain(WARNING)

    await writeOlderSkill(sandbox, file)
    expect((await runCli(['repos'], sandbox)).stderr).toContain(WARNING)
    expect((await runCli(['__complete', 'repos'], sandbox)).stderr).toBe('')
    expect((await runCli(['repos', '--json'], sandbox)).stderr).not.toContain(WARNING)

    await runCli(['skills', 'install'], sandbox)
    expect((await runCli(['repos'], sandbox)).stderr).not.toContain(WARNING)
  })

  it('does not nag about a skill the user edited', async ({ sandbox }) => {
    await mkdir(join(sandbox.root, '.claude'), { recursive: true })
    await runCli(['skills', 'install', '--json', '--no-claude-auto-mode'], sandbox)
    await writeFile(join(sandbox.root, '.claude', 'skills', 'wt-repos', 'SKILL.md'), 'mine\n')

    expect((await runCli(['repos'], sandbox)).stderr).not.toContain(WARNING)
  })
})
