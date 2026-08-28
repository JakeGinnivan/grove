import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listBranches } from '../src/core/git.js'

const execFileAsync = promisify(execFile)

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_CONFIG_SYSTEM: NULL_DEVICE,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

let root: string
let clone: string

/**
 * Commit dates are set explicitly: `for-each-ref --sort=-committerdate` is
 * the whole ordering contract, and commits made back-to-back in a test share
 * a timestamp to the second, which would make the order arbitrary.
 */
async function git(args: string[], cwd: string, date?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: date
      ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : env,
  })
  return stdout.trim()
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wt-branches-')))
  const remote = join(root, 'origin.git')
  const seed = join(root, 'seed')
  clone = join(root, 'clone')

  await mkdir(remote, { recursive: true })
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote], { env })

  await mkdir(seed, { recursive: true })
  await execFileAsync('git', ['init', '--initial-branch=main', seed], { env })
  await writeFile(join(seed, 'README.md'), '# demo\n')
  await git(['add', '.'], seed)
  await git(['commit', '-m', 'initial'], seed, '2020-01-01T00:00:00Z')
  await git(['remote', 'add', 'origin', remote], seed)
  await git(['push', '-u', 'origin', 'main'], seed)

  // Two more branches on the remote, newest last so the sort has work to do.
  await git(['checkout', '-b', 'older'], seed)
  await git(['commit', '--allow-empty', '-m', 'older work'], seed, '2020-02-01T00:00:00Z')
  await git(['push', '-u', 'origin', 'older'], seed)

  await git(['checkout', '-b', 'newer'], seed)
  await git(['commit', '--allow-empty', '-m', 'newer work'], seed, '2020-03-01T00:00:00Z')
  await git(['push', '-u', 'origin', 'newer'], seed)

  await execFileAsync('git', ['clone', remote, clone], { env })
  await git(['remote', 'set-head', 'origin', '--auto'], clone)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('listBranches', () => {
  it('lists local and remote branches, most recent first', async () => {
    const branches = await listBranches(clone)
    expect(branches.map((branch) => branch.name)).toEqual(['newer', 'older', 'main'])
  })

  it('reports a branch that exists only on the remote as remote', async () => {
    const branches = await listBranches(clone)
    expect(branches.find((branch) => branch.name === 'older')?.source).toBe('remote')
  })

  it('reports a checked-out branch as local', async () => {
    // A fresh clone has main checked out locally as well as on origin.
    const branches = await listBranches(clone)
    expect(branches.find((branch) => branch.name === 'main')?.source).toBe('local')
  })

  it('lists a branch once when it exists both locally and on the remote', async () => {
    await git(['checkout', '-b', 'older', 'origin/older'], clone)
    const branches = await listBranches(clone)
    expect(branches.filter((branch) => branch.name === 'older')).toHaveLength(1)
  })

  it('prefers the local ref when a branch exists on both sides', async () => {
    // Local tip is older than origin's, so the local ref only wins if the
    // shadowing rule is about which ref checkout resolves to, not recency.
    await git(['checkout', '-b', 'older', 'origin/older'], clone)
    const branches = await listBranches(clone)
    expect(branches.find((branch) => branch.name === 'older')?.source).toBe('local')
  })

  it('excludes origin/HEAD so it does not surface as a branch', async () => {
    const branches = await listBranches(clone)
    expect(branches.map((branch) => branch.name)).not.toContain('origin')
    expect(branches.map((branch) => branch.name)).not.toContain('HEAD')
  })

  it('carries the commit subject and a relative date for display', async () => {
    const branches = await listBranches(clone)
    const newer = branches.find((branch) => branch.name === 'newer')
    expect(newer?.subject).toBe('newer work')
    expect(newer?.relativeDate).toMatch(/ago$/)
  })

  it('keeps a subject containing a tab intact', async () => {
    await git(['checkout', '-b', 'tabbed', 'main'], clone)
    await git(['commit', '--allow-empty', '-m', 'has\ta tab'], clone, '2020-04-01T00:00:00Z')
    const branches = await listBranches(clone)
    expect(branches.find((branch) => branch.name === 'tabbed')?.subject).toBe('has\ta tab')
  })

  it('returns an empty list for a repo with no commits', async () => {
    const empty = join(root, 'empty')
    await mkdir(empty, { recursive: true })
    await execFileAsync('git', ['init', '--initial-branch=main', empty], { env })
    expect(await listBranches(empty)).toEqual([])
  })
})
