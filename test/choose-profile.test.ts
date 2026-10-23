import { describe, it, expect } from 'vitest'
import { chooseProfile } from '../src/commands/shared.js'
import type { GroveConfig, Profile } from '../src/core/config.js'

function config(
  profiles: Record<string, Profile>,
  defaultProfile?: string,
): GroveConfig {
  return {
    branchPrefix: '',
    reposFile: '/repos',
    defaultCodeDir: '/code',
    profiles,
    useTrash: false,
    taskTrackers: [],
    ...(defaultProfile ? { defaultProfile } : {}),
  }
}

const work = { dir: '/code/work' }
const oss = { dir: '/code/oss' }

// Tests run without a TTY, so chooseProfile can never prompt here.
describe('chooseProfile', () => {
  it('uses no profile when none are configured', async () => {
    expect(await chooseProfile(config({}), undefined)).toBeUndefined()
  })

  it('uses the only profile without asking', async () => {
    expect(await chooseProfile(config({ work }), undefined)).toMatchObject({ name: 'work' })
  })

  it('uses the default when several exist', async () => {
    expect(await chooseProfile(config({ work, oss }, 'oss'), undefined)).toMatchObject({
      name: 'oss',
    })
  })

  it('lets --profile override the default', async () => {
    expect(await chooseProfile(config({ work, oss }, 'oss'), 'work')).toMatchObject({
      name: 'work',
    })
  })

  it('asks for --profile when several exist and none is the default', async () => {
    await expect(chooseProfile(config({ work, oss }), undefined)).rejects.toMatchObject({
      code: 'needs_input',
      hint: expect.stringContaining('--profile <oss|work>'),
    })
  })

  it('rejects an unknown --profile', async () => {
    await expect(chooseProfile(config({ work }), 'nope')).rejects.toMatchObject({
      code: 'unknown_profile',
    })
  })
})
