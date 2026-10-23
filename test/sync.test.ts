import { describe, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  runCli,
  gitIn,
} from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'
import { pushCommit } from './helpers/grove.js'

describe('wt sync', () => {
  it('fast-forwards main when new commits land upstream', async ({ sandbox }) => {
    const pushed = await pushCommit(sandbox, { file: 'new.txt' })

    // Guard the setup: if the push did not land, the sync assertions below
    // would fail for a reason that has nothing to do with sync.
    const onRemote = await gitIn(['rev-parse', 'main'], sandbox.remote)
    expect(onRemote).toBe(pushed)

    const before = await gitIn(['rev-parse', 'HEAD'], sandbox.mainPath)
    const result = await runCli(['sync', 'demo', '--json'], sandbox)
    expect(result.exitCode).toBe(0)
    const data = result.json<{
      results: { updated: boolean; skipped: string | null }[]
    }>()
    // Assert on the whole result: a skip reason explains a failure here far
    // better than a bare `expected false to be true`.
    expect(data.results[0]).toMatchObject({ updated: true, skipped: null })

    const after = await gitIn(['rev-parse', 'HEAD'], sandbox.mainPath)
    expect(after).not.toBe(before)
    expect(existsSync(join(sandbox.mainPath, 'new.txt'))).toBe(true)
  })

  it('reports a failed fetch instead of "already up to date"', async ({ sandbox }) => {
    // Make origin unreachable. Without a fetch check, origin/* still points at
    // the old commit, the fast-forward no-ops, and sync looks successful.
    await gitIn(
      ['remote', 'set-url', 'origin', join(sandbox.root, 'missing.git')],
      sandbox.mainPath,
    )

    const result = await runCli(['sync', 'demo', '--json'], sandbox)
    const data = result.json<{
      results: { updated: boolean; skipped: string | null }[]
    }>()
    expect(data.results[0]?.updated).toBe(false)
    expect(data.results[0]?.skipped).toMatch(/^fetch failed:/)
  })

  it('reports no-op when already current', async ({ sandbox }) => {
    const result = await runCli(['sync', 'demo', '--json'], sandbox)
    const data = result.json<{ results: { updated: boolean }[] }>()
    expect(data.results[0]?.updated).toBe(false)
  })

  it('refuses to update a detached main checkout', async ({ sandbox }) => {
    await gitIn(['checkout', '--detach'], sandbox.mainPath)

    const result = await runCli(['sync', 'demo', '--json'], sandbox)
    const data = result.json<{ results: { skipped: string | null }[] }>()
    expect(data.results[0]?.skipped).toMatch(/detached/)
  })

  it('refuses to touch a dirty main checkout', async ({ sandbox }) => {
    await writeFile(join(sandbox.mainPath, 'local.txt'), 'wip\n')
    const result = await runCli(['sync', 'demo', '--json'], sandbox)
    const data = result.json<{ results: { skipped: string | null }[] }>()
    expect(data.results[0]?.skipped).toMatch(/uncommitted changes/)
  })
})
