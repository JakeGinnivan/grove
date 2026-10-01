import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, utimes, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_TRASH, purgeLocalTrash } from '../src/core/trash.js'

let parent: string

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'grove-trash-'))
})

afterEach(async () => {
  await rm(parent, { recursive: true, force: true })
})

describe('purgeLocalTrash', () => {
  it('deletes entries older than two weeks and keeps newer ones', async () => {
    const day = 24 * 60 * 60 * 1000
    const now = Date.now()
    for (const [name, age] of [['old', 15], ['recent', 13]] as const) {
      const slot = join(parent, LOCAL_TRASH, name)
      await mkdir(join(slot, 'worktree'), { recursive: true })
      const when = new Date(now - age * day)
      await utimes(slot, when, when)
    }

    expect(await purgeLocalTrash(parent, now)).toBe(1)
    expect(await readdir(join(parent, LOCAL_TRASH))).toEqual(['recent'])
  })

  it('does nothing when there is no local trash', async () => {
    expect(await purgeLocalTrash(parent)).toBe(0)
  })
})
