import { describe, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runCli, startCli, gitIn, type Sandbox } from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'
import { expectError, newWorktree } from './helpers/grove.js'

interface FocusResult {
  path: string
  created: boolean
  worktree: string
  branch: string
  commit: string
  previous: { owner: { worktree: string } | null; commit: string } | null
}

interface StatusResult {
  focused: boolean
  path: string | null
  owner: { worktree: string; branch: string | null } | null
  commit: string | null
  head: string | null
  behind: number | null
  dirty: boolean
}

async function focus(sandbox: Sandbox, cwd: string, ...args: string[]) {
  return runCli(['focus', ...args, '--json'], sandbox, { PWD: cwd })
}

async function focused(sandbox: Sandbox, cwd: string, ...args: string[]): Promise<FocusResult> {
  const result = await focus(sandbox, cwd, ...args)
  expect(result.exitCode, result.stdout || result.stderr).toBe(0)
  return result.json()
}

async function status(sandbox: Sandbox): Promise<StatusResult> {
  const result = await runCli(['focus', 'status', '--json'], sandbox, { PWD: sandbox.mainPath })
  expect(result.exitCode, result.stdout || result.stderr).toBe(0)
  return result.json()
}

async function commit(path: string, file: string): Promise<string> {
  await writeFile(join(path, file), `${file}\n`)
  await gitIn(['add', '.'], path)
  await gitIn(['commit', '-m', `add ${file}`], path)
  return gitIn(['rev-parse', 'HEAD'], path)
}

/**
 * A local config whose hooks append one line per run to `hooks.log` in the
 * sandbox root, recording the phase and the environment grove passed.
 */
async function writeHookConfig(sandbox: Sandbox, where: 'local' | 'repo', extra = {}) {
  const log = join(sandbox.root, 'hooks.log')
  const line = (phase: string) =>
    `echo "${phase} owner=$(basename "$GROVE_FOCUS_WORKTREE") from=$GROVE_FOCUS_FROM to=$GROVE_FOCUS_TO cwd=$(basename "$PWD")" >> '${log}'`
  const config = { focus: { activate: [line('activate')], release: [line('release')], ...extra } }
  const dir = where === 'local' ? sandbox.repoPath : sandbox.mainPath
  await writeFile(join(dir, 'worktree.json'), JSON.stringify(config))
  return log
}

/** Focus is opt-in; tests that do not write their own config enable it bare. */
async function enableFocus(sandbox: Sandbox) {
  await writeFile(join(sandbox.repoPath, 'worktree.json'), JSON.stringify({ focus: {} }))
}

async function hookLines(log: string): Promise<string[]> {
  return existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n') : []
}

describe('grove focus', () => {
  it('is off until the repo enables it', async ({ sandbox }) => {
    const wt = await newWorktree(sandbox, 'not enabled')
    const error = expectError(await focus(sandbox, wt.path), 'focus_not_enabled')
    expect(error.hint).toContain(join(sandbox.repoPath, 'worktree.json'))
    expect(existsSync(join(sandbox.repoPath, 'focus'))).toBe(false)
    expect(await status(sandbox)).toMatchObject({ enabled: false, focused: false })
  })

  it('checks the current worktree\'s commit out, detached, in <repo>/focus', async ({ sandbox }) => {
    await enableFocus(sandbox)
    const wt = await newWorktree(sandbox, 'feature one')
    const head = await commit(wt.path, 'one.txt')

    const data = await focused(sandbox, wt.path)
    expect(data).toMatchObject({ created: true, commit: head, branch: wt.branch })
    expect(data.path).toBe(join(sandbox.repoPath, 'focus'))
    expect(await gitIn(['rev-parse', 'HEAD'], data.path)).toBe(head)
    // Detached: committing in the worktree must never move the focus checkout.
    expect(await gitIn(['rev-parse', '--abbrev-ref', 'HEAD'], data.path)).toBe('HEAD')

    expect(await status(sandbox)).toMatchObject({
      focused: true, commit: head, head, behind: 0, dirty: false,
      owner: { worktree: wt.path, branch: wt.branch },
    })
  })

  it('focuses a named worktree from anywhere in the repo', async ({ sandbox }) => {
    await enableFocus(sandbox)
    const wt = await newWorktree(sandbox, 'named target')
    const data = await focused(sandbox, sandbox.mainPath, 'named-target')
    expect(data.worktree).toBe(wt.path)
  })

  it('reports how far the focus worktree is behind, and moves it on refocus', async ({ sandbox }) => {
    await enableFocus(sandbox)
    const wt = await newWorktree(sandbox, 'moving')
    await focused(sandbox, wt.path)
    const newer = await commit(wt.path, 'later.txt')

    expect((await status(sandbox)).behind).toBe(1)
    const data = await focused(sandbox, wt.path)
    expect(data).toMatchObject({ created: false, commit: newer })
    expect(existsSync(join(data.path, 'later.txt'))).toBe(true)
  })

  it('refuses a worktree with uncommitted changes', async ({ sandbox }) => {
    await enableFocus(sandbox)
    const wt = await newWorktree(sandbox, 'dirty one')
    await writeFile(join(wt.path, 'wip.txt'), 'wip\n')
    expectError(await focus(sandbox, wt.path), 'worktree_dirty')
    expect(existsSync(join(sandbox.repoPath, 'focus'))).toBe(false)
  })

  it('refuses when run from main without naming a worktree', async ({ sandbox }) => {
    await enableFocus(sandbox)
    await newWorktree(sandbox, 'some work')
    expectError(await focus(sandbox, sandbox.mainPath), 'focus_needs_worktree')
  })

  it('protects uncommitted changes in the focus worktree unless told to discard them', async ({ sandbox }) => {
    await enableFocus(sandbox)
    const wt = await newWorktree(sandbox, 'protect')
    const data = await focused(sandbox, wt.path)
    await commit(wt.path, 'next.txt')
    await writeFile(join(data.path, 'README.md'), 'changed by a dev server\n')

    expectError(await focus(sandbox, wt.path), 'focus_dirty')
    const again = await focused(sandbox, wt.path, '--discard')
    expect(existsSync(join(again.path, 'next.txt'))).toBe(true)
  })

  it('discards changes a release hook leaves behind only with --discard', async ({ sandbox }) => {
    await writeFile(
      join(sandbox.repoPath, 'worktree.json'),
      JSON.stringify({ focus: { release: ['echo regenerated > README.md'] } }),
    )
    const first = await newWorktree(sandbox, 'leaves changes')
    const second = await newWorktree(sandbox, 'next in line')
    await commit(second.path, 'second.txt')
    const data = await focused(sandbox, first.path)

    expect(expectError(await focus(sandbox, second.path), 'focus_dirty').message)
      .toMatch(/after the release hooks/)
    const switched = await focused(sandbox, second.path, '--discard')
    expect(existsSync(join(data.path, 'second.txt'))).toBe(true)
    expect(switched.worktree).toBe(second.path)
    expect(await gitIn(['status', '--porcelain'], data.path)).toBe('')
  })

  it('uses focus.dir from the local worktree.json', async ({ sandbox }) => {
    await writeFile(
      join(sandbox.repoPath, 'worktree.json'),
      JSON.stringify({ focus: { dir: 'dev-server' } }),
    )
    const wt = await newWorktree(sandbox, 'custom dir')
    const data = await focused(sandbox, wt.path)
    expect(data.path).toBe(join(sandbox.repoPath, 'dev-server'))
  })

  it('rejects a focus.dir that is not a plain directory name', async ({ sandbox }) => {
    await writeFile(
      join(sandbox.repoPath, 'worktree.json'),
      JSON.stringify({ focus: { dir: '../elsewhere' } }),
    )
    const wt = await newWorktree(sandbox, 'bad dir')
    expectError(await focus(sandbox, wt.path), 'invalid_focus_config')
  })

  it('releases the previous owner before activating the next one', async ({ sandbox }) => {
    const log = await writeHookConfig(sandbox, 'local')
    const first = await newWorktree(sandbox, 'first owner')
    const firstHead = await commit(first.path, 'first.txt')
    const second = await newWorktree(sandbox, 'second owner')
    const secondHead = await commit(second.path, 'second.txt')

    await focused(sandbox, first.path)
    // Refocusing the same owner activates again but releases nothing.
    await focused(sandbox, first.path)
    await focused(sandbox, second.path)

    const [one, two] = [basename(first.path), basename(second.path)]
    expect(await hookLines(log)).toEqual([
      `activate owner=${one} from= to=${firstHead} cwd=focus`,
      `activate owner=${one} from=${firstHead} to=${firstHead} cwd=focus`,
      `release owner=${one} from=${firstHead} to=${secondHead} cwd=focus`,
      `activate owner=${two} from=${firstHead} to=${secondHead} cwd=focus`,
    ])
  })

  it('leaves the focus worktree untouched when a release hook fails', async ({ sandbox }) => {
    await writeFile(
      join(sandbox.repoPath, 'worktree.json'),
      JSON.stringify({ focus: { release: ['exit 3'] } }),
    )
    const first = await newWorktree(sandbox, 'keeps focus')
    const firstHead = await commit(first.path, 'first.txt')
    const second = await newWorktree(sandbox, 'wants focus')
    await commit(second.path, 'second.txt')

    const data = await focused(sandbox, first.path)
    expectError(await focus(sandbox, second.path), 'focus_hook_failed')
    expect(await gitIn(['rev-parse', 'HEAD'], data.path)).toBe(firstHead)
    expect((await status(sandbox)).owner?.worktree).toBe(first.path)

    // --no-hooks is the way past a broken hook.
    expect((await focused(sandbox, second.path, '--no-hooks')).worktree).toBe(second.path)
  })

  it('runs hooks committed to the repo only with --setup', async ({ sandbox }) => {
    // Committed hooks are repository code; the sandbox's main checkout stands
    // in for that without a commit, since grove reads the file from disk.
    const log = await writeHookConfig(sandbox, 'repo')
    const wt = await newWorktree(sandbox, 'repo hooks')

    await focused(sandbox, wt.path)
    expect(await hookLines(log)).toEqual([])
    await focused(sandbox, wt.path, '--setup')
    expect(await hookLines(log)).toHaveLength(1)
  })

  it('keeps --json output parseable when hooks print to stdout', async ({ sandbox }) => {
    await writeFile(
      join(sandbox.repoPath, 'worktree.json'),
      JSON.stringify({ focus: { activate: ['echo noisy hook output'] } }),
    )
    const wt = await newWorktree(sandbox, 'noisy')
    const result = await focus(sandbox, wt.path)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.json<FocusResult>().worktree).toBe(wt.path)
    expect(result.stderr).toContain('noisy hook output')
  })
})

describe('grove focus release', () => {
  it('runs the release hooks and leaves the checkout where it is', async ({ sandbox }) => {
    const log = await writeHookConfig(sandbox, 'local')
    const wt = await newWorktree(sandbox, 'to release')
    const head = await commit(wt.path, 'kept.txt')
    const data = await focused(sandbox, wt.path)

    const result = await runCli(['focus', 'release', '--json'], sandbox, { PWD: wt.path })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.json()).toMatchObject({ released: true, owner: { worktree: wt.path } })

    expect((await hookLines(log)).at(-1)).toBe(`release owner=${basename(wt.path)} from=${head} to= cwd=focus`)
    expect(await gitIn(['rev-parse', 'HEAD'], data.path)).toBe(head)
    expect(await status(sandbox)).toMatchObject({ focused: false, owner: null, head, path: data.path })
  })

  it('is a no-op when nothing is focused', async ({ sandbox }) => {
    await enableFocus(sandbox)
    const result = await runCli(['focus', 'release', '--json'], sandbox, { PWD: sandbox.mainPath })
    expect(result.exitCode).toBe(0)
    expect(result.json()).toMatchObject({ released: false })
  })
})

describe('focus in list and cleanup', () => {
  it('marks the focus worktree and its owner, and never offers the focus worktree for removal', async ({ sandbox }) => {
    await enableFocus(sandbox)
    const wt = await newWorktree(sandbox, 'listed owner')
    const data = await focused(sandbox, wt.path)

    const list = await runCli(['list', 'demo', '--json'], sandbox)
    const reports = list.json<{ worktrees: { path: string; isFocus: boolean; focused: boolean }[] }>().worktrees
    expect(reports.find((r) => r.path === data.path)).toMatchObject({ isFocus: true, focused: false })
    expect(reports.find((r) => r.path === wt.path)).toMatchObject({ isFocus: false, focused: true })

    // Still the focus worktree after release, so still protected.
    await runCli(['focus', 'release', '--json'], sandbox, { PWD: wt.path })
    expectError(
      await runCli(['cleanup', 'demo', 'focus', '--yes', '--json'], sandbox),
      'no_matching_worktree',
    )
    const inside = await runCli(['cleanup', 'self', '--yes', '--json'], sandbox, { PWD: data.path })
    expectError(inside, 'is_focus_worktree')
    expect(existsSync(data.path)).toBe(true)
  })
})

describe('grove focus pull', () => {
  it('moves the focus worktree to its owner\'s latest commit, from anywhere', async ({ sandbox }) => {
    await enableFocus(sandbox)
    const wt = await newWorktree(sandbox, 'pulled owner')
    const data = await focused(sandbox, wt.path)
    const newer = await commit(wt.path, 'newer.txt')
    // A dirty owner is fine: pull only ever takes what is committed.
    await writeFile(join(wt.path, 'wip.txt'), 'wip\n')

    const pull = await runCli(['focus', 'pull', '--json'], sandbox, { PWD: data.path })
    expect(pull.exitCode, pull.stderr).toBe(0)
    expect(pull.json()).toMatchObject({ updated: true, from: data.commit, to: newer })
    expect(await gitIn(['rev-parse', 'HEAD'], data.path)).toBe(newer)
    expect(existsSync(join(data.path, 'wip.txt'))).toBe(false)

    const again = await runCli(['focus', 'pull', '--json'], sandbox, { PWD: sandbox.mainPath })
    expect(again.json()).toMatchObject({ updated: false })
  })

  it('fails when nothing is focused', async ({ sandbox }) => {
    await enableFocus(sandbox)
    const result = await runCli(['focus', 'pull', '--json'], sandbox, { PWD: sandbox.mainPath })
    expectError(result, 'focus_not_owned')
  })

  it('refuses to strand commits made in the focus worktree', async ({ sandbox }) => {
    await enableFocus(sandbox)
    const wt = await newWorktree(sandbox, 'strand guard')
    const data = await focused(sandbox, wt.path)
    const stray = await commit(data.path, 'made-in-focus.txt')

    const error = expectError(
      await runCli(['focus', 'pull', '--json'], sandbox, { PWD: data.path }),
      'focus_has_commits',
    )
    expect(error.hint).toContain(`git -C ${wt.path} merge --ff-only ${stray.slice(0, 12)}`)

    // Once the worktree has them, they are home and the pull goes ahead.
    await gitIn(['merge', '--ff-only', stray], wt.path)
    const pull = await runCli(['focus', 'pull', '--json'], sandbox, { PWD: data.path })
    expect(pull.exitCode, pull.stderr).toBe(0)
    expect((await status(sandbox)).commit).toBe(stray)
  })
})

describe('grove focus --watch', () => {
  const isEvent = (name: string) => (line: string) =>
    (JSON.parse(line) as { event: string }).event === name

  it('pulls new commits as they land and releases when stopped', async ({ sandbox }) => {
    const log = await writeHookConfig(sandbox, 'local')
    const wt = await newWorktree(sandbox, 'watched')
    const watcher = startCli(['focus', '--watch', '--interval', '0.1', '--json'], sandbox, { PWD: wt.path })
    await watcher.waitForLine(isEvent('focused'))

    const newer = await commit(wt.path, 'watched.txt')
    const pulled = JSON.parse(await watcher.waitForLine(isEvent('pulled'))) as { to: string }
    expect(pulled.to).toBe(newer)

    watcher.signal('SIGTERM')
    const { exitCode, stdout } = await watcher.exited
    expect(exitCode).toBe(0)
    expect(stdout).toContain('"event":"released"')
    expect(await status(sandbox)).toMatchObject({ focused: false, head: newer })
    expect((await hookLines(log)).at(-1)).toMatch(/^release /)
  })

  it('stops without releasing when another worktree takes over', async ({ sandbox }) => {
    const log = await writeHookConfig(sandbox, 'local')
    const first = await newWorktree(sandbox, 'watching first')
    const second = await newWorktree(sandbox, 'takes over')
    const watcher = startCli(['focus', '--watch', '--interval', '0.1', '--json'], sandbox, { PWD: first.path })
    await watcher.waitForLine(isEvent('focused'))

    await focused(sandbox, second.path)
    const lost = JSON.parse(await watcher.waitForLine(isEvent('lost'))) as { owner: { worktree: string } }
    expect(lost.owner.worktree).toBe(second.path)
    expect((await watcher.exited).stdout).not.toContain('"event":"released"')

    // One release, by the takeover; the watcher did not release the newcomer.
    expect((await hookLines(log)).filter((line) => line.startsWith('release '))).toHaveLength(1)
    expect((await status(sandbox)).owner?.worktree).toBe(second.path)
  })
})
