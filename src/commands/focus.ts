import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor } from '../core/registry.js'
import { git, isDirty, listWorktrees } from '../core/git.js'
import { samePath } from '../core/paths.js'
import { loadWorktrees, matchWorktree } from '../core/worktree-view.js'
import {
  readFocusConfig,
  readFocusState,
  runFocusHooks,
  writeFocusState,
  type FocusOwner,
  type FocusState,
} from '../core/focus.js'
import { emitJson, getOutputContext, info, log, success } from '../core/output.js'
import { WtError } from '../core/errors.js'

interface RepoContext {
  rootWorktree: string
  repoPath: string
  /** The worktree the command was run from, when it was run inside one. */
  current: string | undefined
}

/** The repo named by `--repo`, otherwise the one containing the current directory. */
async function repoContext(repoName: string | undefined): Promise<RepoContext> {
  let gitDir: string
  let current: string | undefined
  if (repoName) {
    const config = await loadConfig()
    gitDir = await gitDirFor((await resolveRepo(config.reposFile, repoName)).path)
  } else {
    const top = await git(['rev-parse', '--show-toplevel'], { cwd: process.cwd(), allowFailure: true })
    if (top.exitCode !== 0) {
      throw new WtError('Run this inside a worktree, or name the repo with --repo.', {
        code: 'not_in_worktree',
      })
    }
    gitDir = top.stdout
    current = top.stdout
  }
  const rootWorktree = (await listWorktrees(gitDir))[0]?.path
  if (!rootWorktree || basename(rootWorktree) !== 'main') {
    throw new WtError('Focus needs grove\'s layout, with the main checkout in <repo>/main.', {
      code: 'focus_needs_layout',
    })
  }
  return { rootWorktree, repoPath: dirname(rootWorktree), current }
}

async function headOf(path: string): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], { cwd: path })).stdout
}

interface FocusOptions {
  repo?: string
  setup?: boolean
  hooks?: boolean
  discard?: boolean
}

function hookOptions(options: FocusOptions) {
  return { trustRepo: options.setup ?? false, enabled: options.hooks ?? true }
}

export function focusCommand(): Command {
  const command = new Command('focus')
    .description('Check a worktree\'s commit out in the single focus worktree')
    .argument('[worktree]', 'worktree to focus (default: the current one)')
    .option('--repo <repo>', 'registered repo name (default: the current directory\'s repo)')
    .option('--setup', 'also run focus hooks committed to the repo')
    .option('--no-hooks', 'skip the activate and release hooks')
    .option('--discard', 'discard uncommitted changes in the focus worktree first')
    .action(async (worktree: string | undefined, options: FocusOptions) => {
      await runFocus(worktree, options)
    })

  command.command('status')
    .description('Show which worktree is focused')
    .option('--repo <repo>', 'registered repo name')
    .action(async (options: FocusOptions) => {
      await runStatus(options)
    })

  command.command('release')
    .description('Run the release hooks and leave the focus worktree unowned, where it is')
    .option('--repo <repo>', 'registered repo name')
    .option('--setup', 'also run focus hooks committed to the repo')
    .option('--no-hooks', 'skip the release hooks')
    .action(async (options: FocusOptions) => {
      await runRelease(options)
    })

  return command
}

async function runFocus(worktreeArg: string | undefined, options: FocusOptions): Promise<void> {
  const repo = await repoContext(options.repo)
  const config = await readFocusConfig(repo.rootWorktree)
  // Opt-in: most repos run happily from every worktree at once, and a stray
  // `grove focus` there would leave an unexplained extra checkout behind.
  if (config.source === null) {
    throw new WtError('Focus is not enabled for this repo.', {
      code: 'focus_not_enabled',
      hint: `Add "focus": {} to ${join(repo.repoPath, 'worktree.json')} to enable it.`,
    })
  }
  const state = await readFocusState(repo.rootWorktree)
  const focusPath = state?.path ?? join(repo.repoPath, config.dir)

  const reports = await loadWorktrees(repo.rootWorktree, { status: false })
  const focusable = reports.filter(
    (report) => !report.isMain && !samePath(report.path, focusPath),
  )
  let target
  if (worktreeArg) {
    target = matchWorktree(focusable, worktreeArg, { partial: true })
  } else {
    target = repo.current
      ? focusable.find((report) => samePath(report.path, repo.current!))
      : undefined
    if (!target) {
      throw new WtError('Name the worktree to focus, or run this inside it.', {
        code: 'focus_needs_worktree',
        hint: focusable.length
          ? `Worktrees: ${focusable.map((report) => report.dir).join(', ')}`
          : 'Create one with `grove new`.',
      })
    }
  }

  // Only committed work can be checked out elsewhere; anything uncommitted
  // would silently be left behind.
  if (await isDirty(target.path)) {
    throw new WtError(`${target.dir} has uncommitted changes.`, {
      code: 'worktree_dirty',
      hint: 'Commit them first; focus checks out the worktree\'s HEAD commit.',
    })
  }
  const commit = await headOf(target.path)
  const owner: FocusOwner = { worktree: target.path, branch: target.branch }

  const registered = reports.some((report) => samePath(report.path, focusPath))
  if (!registered && existsSync(focusPath)) {
    throw new WtError(`${focusPath} exists but is not a worktree of this repo.`, {
      code: 'focus_path_occupied',
      hint: 'Move it aside, or choose another directory with "focus": { "dir": ... } in worktree.json.',
    })
  }

  const dirtyFocus = (when: string) =>
    new WtError(`The focus worktree has uncommitted changes${when}.`, {
      code: 'focus_dirty',
      hint: `Inspect them with \`git -C ${focusPath} status\`, or pass --discard to throw them away.`,
    })
  if (registered && !options.discard && await isDirty(focusPath)) throw dirtyFocus('')

  const context = { rootWorktree: repo.rootWorktree, focusPath }
  const previous = registered ? state : undefined
  const ownerChanged = !!previous?.owner && !samePath(previous.owner.worktree, owner.worktree)
  if (ownerChanged) {
    // The outgoing owner's code is still checked out, so its hooks can undo
    // what that code did (roll back its migrations, say).
    await runFocusHooks('release', config, {
      ...context, owner: previous!.owner, from: previous!.commit, to: commit,
    }, hookOptions(options))
  }

  // Checked again after the release hooks, which can leave changes of their
  // own; a checkout would otherwise carry them onto the next commit.
  if (registered && await isDirty(focusPath)) {
    if (!options.discard) throw dirtyFocus(' after the release hooks')
    await git(['reset', '--hard', '--quiet'], { cwd: focusPath })
  }

  if (registered) {
    await git(['checkout', '--detach', '--quiet', commit], { cwd: focusPath })
  } else {
    info(`Creating focus worktree at ${focusPath}...`)
    await git(['worktree', 'add', '--detach', focusPath, commit], {
      cwd: repo.rootWorktree, stream: true,
    })
  }

  const next: FocusState = { path: focusPath, owner, commit, updatedAt: new Date().toISOString() }
  await writeFocusState(repo.rootWorktree, next)

  await runFocusHooks('activate', config, {
    ...context, owner, from: previous?.commit ?? null, to: commit,
  }, hookOptions(options))

  if (getOutputContext().json) {
    emitJson({
      ok: true,
      path: focusPath,
      created: !registered,
      worktree: target.path,
      branch: target.branch,
      commit,
      previous: previous ? { owner: previous.owner, commit: previous.commit } : null,
    })
    return
  }
  success(
    `Focused ${pc.cyan(target.dir)} at ${commit.slice(0, 8)} in ${pc.bold(basename(focusPath))}`,
  )
}

interface FocusStatus {
  enabled: boolean
  focused: boolean
  path: string | null
  exists: boolean
  owner: FocusOwner | null
  ownerExists: boolean
  commit: string | null
  /** The focus worktree's actual HEAD, which differs from `commit` if someone moved it. */
  head: string | null
  /** Commits the owner worktree has that the focus worktree does not. */
  behind: number | null
  dirty: boolean
}

async function runStatus(options: FocusOptions): Promise<void> {
  const repo = await repoContext(options.repo)
  const config = await readFocusConfig(repo.rootWorktree)
  const state = await readFocusState(repo.rootWorktree)
  const exists = !!state && existsSync(state.path)
  const ownerExists = !!state?.owner && existsSync(state.owner.worktree)

  const status: FocusStatus = {
    enabled: config.source !== null,
    focused: !!state?.owner,
    path: state?.path ?? null,
    exists,
    owner: state?.owner ?? null,
    ownerExists,
    commit: state?.commit ?? null,
    head: exists ? await headOf(state!.path) : null,
    behind: null,
    dirty: exists ? await isDirty(state!.path) : false,
  }
  if (state?.owner && ownerExists) {
    const count = await git(
      ['rev-list', '--count', `${state.commit}..${await headOf(state.owner.worktree)}`],
      { cwd: repo.rootWorktree, allowFailure: true },
    )
    if (count.exitCode === 0) status.behind = Number(count.stdout)
  }

  if (getOutputContext().json) {
    emitJson({ ok: true, ...status })
    return
  }
  if (!state || !exists) {
    log(status.enabled
      ? 'No focus worktree yet. Create one with `grove focus` inside a worktree.'
      : 'Focus is not enabled for this repo.')
    return
  }
  log(`${pc.bold('Focus worktree')}  ${state.path}`)
  log(`${pc.bold('Commit')}          ${(status.head ?? state.commit).slice(0, 8)}` +
    (status.head && status.head !== state.commit ? pc.yellow(` (recorded ${state.commit.slice(0, 8)})`) : ''))
  if (!state.owner) {
    log(`${pc.bold('Owner')}           ${pc.dim('none (released)')}`)
  } else {
    const ownerLabel = `${basename(state.owner.worktree)} ${pc.dim(state.owner.branch ?? '(detached)')}`
    log(`${pc.bold('Owner')}           ${ownerLabel}` +
      (ownerExists ? '' : pc.yellow(' (worktree no longer exists)')))
    if (status.behind) log(pc.cyan(`  ${status.behind} commit(s) behind its worktree; run \`grove focus\` there to update`))
  }
  if (status.dirty) log(pc.yellow('  Uncommitted changes in the focus worktree'))
}

async function runRelease(options: FocusOptions): Promise<void> {
  const repo = await repoContext(options.repo)
  const config = await readFocusConfig(repo.rootWorktree)
  const state = await readFocusState(repo.rootWorktree)

  if (!state?.owner || !existsSync(state.path)) {
    if (getOutputContext().json) emitJson({ ok: true, released: false, owner: null })
    else log('Nothing is focused.')
    return
  }

  await runFocusHooks('release', config, {
    rootWorktree: repo.rootWorktree,
    focusPath: state.path,
    owner: state.owner,
    from: state.commit,
    to: null,
  }, hookOptions(options))
  await writeFocusState(repo.rootWorktree, { ...state, owner: null, updatedAt: new Date().toISOString() })

  if (getOutputContext().json) {
    emitJson({ ok: true, released: true, owner: state.owner, path: state.path, commit: state.commit })
    return
  }
  success(`Released ${pc.cyan(basename(state.owner.worktree))}; ${basename(state.path)} stays at ${state.commit.slice(0, 8)}`)
}
