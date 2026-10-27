import { describe, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  runCli,
  runCliWithTty,
  type Sandbox,
} from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'

describe('grove setup', () => {
  const DOWN = '\x1b[B'
  const CTRL_C = '\x03'
  const readConfig = async (sandbox: Sandbox) =>
    JSON.parse(await readFile(join(sandbox.root, '.config', 'grove', 'config.json'), 'utf8')) as {
      branchPrefix: string
      useTrash: boolean
      taskTrackers: string[]
    }

  it('sets only the values passed as flags', async ({ sandbox }) => {
    await runCli(['setup', '--branch-prefix', 'me/', '--json'], sandbox)
    const result = await runCli(['setup', '--no-trash', '--json'], sandbox)
    expect(result.json<{ changed: boolean }>().changed).toBe(true)
    expect(await readConfig(sandbox)).toMatchObject({ branchPrefix: 'me/', useTrash: false })

    const again = await runCli(['setup', '--no-trash', '--json'], sandbox)
    expect(again.json<{ changed: boolean }>().changed).toBe(false)
  })

  it('lists every setting with its value and leaves them alone on Done', async ({ sandbox }) => {
    await runCli(['setup', '--branch-prefix', 'me/', '--json'], sandbox)
    const result = await runCliWithTty(['setup'], sandbox, {}, {
      steps: [{ answerWhen: 'Choose a setting', keys: `${DOWN.repeat(6)}\r` }],
    })
    expect(result.exitCode).toBe(0)
    for (const label of ['Branch prefix', 'Clone directory', 'Repo registry', 'Task trackers', 'Use trash']) {
      expect(result.stderr).toContain(label)
    }
    expect(result.stderr).toContain('me/')
    expect(result.stderr).toContain('No changes.')
  })

  it('edits one setting and returns to the menu before saving', async ({ sandbox }) => {
    await runCli(['setup', '--branch-prefix', 'me/', '--json'], sandbox)
    const result = await runCliWithTty(['setup'], sandbox, {}, {
      steps: [
        { answerWhen: 'Choose a setting', keys: `${DOWN.repeat(3)}\r` },
        // Jira is on by default: turn it off and turn GitHub on.
        { answerWhen: 'Task trackers for issue keys', keys: ` ${DOWN.repeat(2)} \r` },
        { answerWhen: 'Save and exit', keys: `${DOWN.repeat(3)}\r` },
      ],
    })
    expect(result.exitCode).toBe(0)
    expect(await readConfig(sandbox)).toMatchObject({ branchPrefix: 'me/', taskTrackers: ['github'] })
  })

  it('goes back to the menu when a single setting is cancelled', async ({ sandbox }) => {
    await runCli(['setup', '--branch-prefix', 'me/', '--json'], sandbox)
    const result = await runCliWithTty(['setup'], sandbox, {}, {
      steps: [
        { answerWhen: 'Choose a setting' },
        { answerWhen: 'Branch prefix for generated branches', keys: `x${CTRL_C}` },
        { answerWhen: 'Choose a setting', keys: `${DOWN.repeat(6)}\r` },
      ],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('No changes.')
    expect((await readConfig(sandbox)).branchPrefix).toBe('me/')
  })

  // Windows always detects PowerShell, whose profile path is covered by the
  // shell-init tests.
  it.skipIf(process.platform === 'win32')(
    'adds shell integration from the menu only on save',
    async ({ sandbox }) => {
      await runCli(['setup', '--branch-prefix', 'me/', '--json'], sandbox)
      const env = { SHELL: '/bin/zsh', ZDOTDIR: '' }
      const zshrc = join(sandbox.root, '.zshrc')

      const discarded = await runCliWithTty(['setup'], sandbox, env, {
        steps: [
          { answerWhen: 'Choose a setting', keys: `${DOWN.repeat(5)}\r` },
          { answerWhen: 'Add the `wt` command', keys: '\r' },
          { answerWhen: 'will add to ~/.zshrc', keys: CTRL_C },
        ],
      })
      expect(discarded.exitCode).toBe(0)
      expect(existsSync(zshrc)).toBe(false)

      const saved = await runCliWithTty(['setup'], sandbox, env, {
        steps: [
          { answerWhen: 'Choose a setting', keys: `${DOWN.repeat(5)}\r` },
          { answerWhen: 'Add the `wt` command', keys: '\r' },
          // The cursor stays on Shell integration, one above Save.
          { answerWhen: 'Save and exit', keys: `${DOWN}\r` },
        ],
      })
      expect(saved.exitCode).toBe(0)
      expect(await readFile(zshrc, 'utf8')).toContain('eval "$(grove shell-init zsh)"')
      expect(saved.stderr).not.toContain('No changes.')

      const shown = await runCliWithTty(['setup'], sandbox, env, {
        steps: [{ answerWhen: 'installed in ~/.zshrc', keys: `${DOWN.repeat(6)}\r` }],
      })
      expect(shown.exitCode).toBe(0)
    },
  )
})
