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
  hasFocusChanges,
  readFocusConfig,
  readFocusState,
  resetRegenerated,
  runFocusHooks,
  writeFocusState,
  type FocusConfig,
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

const DEFAULT_WATCH_SECONDS = 2

interface FocusOptions {
  repo?: string
  setup?: boolean
  hooks?: boolean
  discard?: boolean
  watch?: boolean
  activate?: boolean
  interval?: string
}

function hookOptions(options: FocusOptions) {
  return { trustRepo: options.setup ?? false, enabled: options.hooks ?? true }
}

export function focusCommand(): Command {
  const command = new Command('focus')
    .description('Check a worktree\'s commit out in the single focus worktree')
    // focus and its subcommands share option names (--discard, --repo,
    // --setup); this hands options after `pull` to pull, not to focus.
    .enablePositionalOptions()
    .argument('[worktree]', 'worktree to focus (default: the current one)')
    .option('--repo <repo>', 'registered repo name (default: the current directory\'s repo)')
    .option('--setup', 'also run focus hooks committed to the repo')
    .option('--no-hooks', 'skip the activate and release hooks')
    .option('--discard', 'discard uncommitted changes in the focus worktree first')
    .option('--watch', 'keep pulling the worktree\'s new commits until stopped, then release')
    .option('--interval <seconds>', `how often --watch checks for commits (default ${DEFAULT_WATCH_SECONDS})`)
    .action(async (worktree: string | undefined, options: FocusOptions) => {
      await runFocus(worktree, options)
    })

  command.command('pull')
    .description('Move the focus worktree to its owner\'s latest commit')
    .option('--repo <repo>', 'registered repo name')
    .option('--activate', 'also run the activate hooks, even if already up to date')
    .option('--setup', 'with --activate, also run hooks committed to the repo')
    .option('--discard', 'discard uncommitted changes in the focus worktree first')
    .action(async (options: FocusOptions) => {
      await runPull(options)
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

function requireEnabled(repo: RepoContext, config: FocusConfig): void {
  // Opt-in: most repos run happily from every worktree at once, and a stray
  // `grove focus` there would leave an unexplained extra checkout behind.
  if (config.source === null) {
    throw new WtError('Focus is not enabled for this repo.', {
      code: 'focus_not_enabled',
      hint: `Add "focus": {} to ${join(repo.repoPath, 'worktree.json')} to enable it.`,
    })
  }
}

interface MoveResult {
  path: string
  created: boolean
  owner: FocusOwner
  commit: string
  previous: { owner: FocusOwner | null; commit: string } | null
}

/**
 * Check `commit` out in the focus worktree for `owner`: release the previous
 * owner if it is changing hands, check out, record, then activate unless
 * this is a pull. A pull only moves the code along under a running app, and
 * re-running setup is what `grove focus` is for.
 */
async function moveFocus(
  repo: RepoContext,
  config: FocusConfig,
  owner: FocusOwner,
  commit: string,
  options: FocusOptions,
  { activate }: { activate: boolean },
): Promise<MoveResult> {
  const state = await readFocusState(repo.rootWorktree)
  const focusPath = state?.path ?? join(repo.repoPath, config.dir)
  const registered = (await listWorktrees(repo.rootWorktree))
    .some((worktree) => samePath(worktree.path, focusPath))
  if (!registered && existsSync(focusPath)) {
    throw new WtError(`${focusPath} exists but is not a worktree of this repo.`, {
      code: 'focus_path_occupied',
      hint: 'Move it aside, or choose another directory with "focus": { "dir": ... } in worktree.json.',
    })
  }
  const previous = registered ? state : undefined

  // Commits made in the focus worktree are on no branch. Checking out another
  // commit would leave them reachable only from the reflog, so stop and say
  // how to bring them home.
  if (previous) {
    // Commits already in the incoming commit (the worktree fast-forwarded to
    // them) are home, so only the rest count.
    const made = await git(['rev-list', '--count', 'HEAD', `^${previous.commit}`, `^${commit}`], {
      cwd: focusPath, allowFailure: true,
    })
    if (!options.discard && made.exitCode === 0 && Number(made.stdout) > 0) {
      const head = (await headOf(focusPath)).slice(0, 12)
      const home = previous.owner?.worktree ?? '<worktree>'
      throw new WtError(`The focus worktree has ${made.stdout} commit(s) of its own.`, {
        code: 'focus_has_commits',
        hint: `Bring them to the worktree with \`git -C ${home} merge --ff-only ${head}\` and refocus. ` +
          `If it has moved on, cherry-pick ${previous.commit.slice(0, 12)}..${head} there instead, then refocus with --discard.`,
      })
    }
  }

  const dirtyFocus = (when: string) =>
    new WtError(`The focus worktree has uncommitted changes${when}.`, {
      code: 'focus_dirty',
      hint: `Inspect them with \`git -C ${focusPath} status\`, or pass --discard to throw them away.`,
    })
  if (registered && !options.discard && await hasFocusChanges(focusPath, config)) throw dirtyFocus('')

  const context = { rootWorktree: repo.rootWorktree, focusPath }
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
  if (registered && await hasFocusChanges(focusPath, config)) {
    if (!options.discard) throw dirtyFocus(' after the release hooks')
    await git(['reset', '--hard', '--quiet'], { cwd: focusPath })
  }

  if (registered) {
    await resetRegenerated(focusPath, config)
    await git(['checkout', '--detach', '--quiet', commit], { cwd: focusPath })
  } else {
    info(`Creating focus worktree at ${focusPath}...`)
    await git(['worktree', 'add', '--detach', focusPath, commit], {
      cwd: repo.rootWorktree, stream: true,
    })
  }

  const next: FocusState = { path: focusPath, owner, commit, updatedAt: new Date().toISOString() }
  await writeFocusState(repo.rootWorktree, next)

  if (activate) {
    await runFocusHooks('activate', config, {
      ...context, owner, from: previous?.commit ?? null, to: commit,
    }, hookOptions(options))
  }

  return {
    path: focusPath,
    created: !registered,
    owner,
    commit,
    previous: previous ? { owner: previous.owner, commit: previous.commit } : null,
  }
}

async function runFocus(worktreeArg: string | undefined, options: FocusOptions): Promise<void> {
  const repo = await repoContext(options.repo)
  const config = await readFocusConfig(repo.rootWorktree)
  requireEnabled(repo, config)
  const interval = watchInterval(options)
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
  const owner: FocusOwner = { worktree: target.path, branch: target.branch }
  const moved = await moveFocus(repo, config, owner, await headOf(target.path), options, { activate: true })

  if (interval !== undefined) {
    await watch(repo, config, moved, interval, options)
    return
  }
  if (getOutputContext().json) {
    emitJson({
      ok: true,
      path: moved.path,
      created: moved.created,
      worktree: owner.worktree,
      branch: owner.branch,
      commit: moved.commit,
      previous: moved.previous,
    })
    return
  }
  success(
    `Focused ${pc.cyan(target.dir)} at ${moved.commit.slice(0, 8)} in ${pc.bold(basename(moved.path))}`,
  )
}

/** The focus worktree's current owner, which `pull` and `--watch` follow. */
async function currentOwner(repo: RepoContext): Promise<{ state: FocusState; owner: FocusOwner }> {
  const state = await readFocusState(repo.rootWorktree)
  if (!state?.owner || !existsSync(state.path)) {
    throw new WtError('Nothing is focused.', {
      code: 'focus_not_owned',
      hint: 'Run `grove focus` inside the worktree you want to run.',
    })
  }
  if (!existsSync(state.owner.worktree)) {
    throw new WtError(`The focused worktree ${state.owner.worktree} no longer exists.`, {
      code: 'focus_owner_missing',
      hint: 'Focus another worktree, or run `grove focus release`.',
    })
  }
  return { state, owner: state.owner }
}

async function runPull(options: FocusOptions): Promise<void> {
  const repo = await repoContext(options.repo)
  const config = await readFocusConfig(repo.rootWorktree)
  requireEnabled(repo, config)
  const { state, owner } = await currentOwner(repo)

  // Unlike the first focus, a dirty owner is fine: pull takes what is
  // committed, which is all it ever could take.
  const commit = await headOf(owner.worktree)
  const updated = commit !== state.commit || await headOf(state.path) !== commit
  const activate = options.activate ?? false
  if (updated) {
    await moveFocus(repo, config, owner, commit, options, { activate })
  } else if (activate) {
    await runFocusHooks('activate', config, {
      rootWorktree: repo.rootWorktree, focusPath: state.path, owner, from: commit, to: commit,
    }, hookOptions(options))
  }

  if (getOutputContext().json) {
    emitJson({
      ok: true, updated, activated: activate, path: state.path,
      worktree: owner.worktree, from: state.commit, to: commit,
    })
    return
  }
  if (updated) success(`Pulled ${basename(owner.worktree)}: ${state.commit.slice(0, 8)} → ${commit.slice(0, 8)}`)
  else log(`  ${pc.dim('·')} ${basename(state.path)} is already at ${basename(owner.worktree)}'s HEAD`)
}

function watchInterval(options: FocusOptions): number | undefined {
  if (!options.watch) return undefined
  const seconds = Number(options.interval ?? DEFAULT_WATCH_SECONDS)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new WtError('--interval takes a positive number of seconds.', { code: 'invalid_watch_interval' })
  }
  return seconds * 1000
}

/**
 * One line per event. Watch never finishes with a single result, so in JSON
 * mode each event is its own compact JSON line.
 */
function event(name: string, data: Record<string, unknown>, text: string): void {
  if (getOutputContext().json) {
    process.stdout.write(`${JSON.stringify({ event: name, ...data })}\n`)
  } else {
    log(`${pc.dim(new Date().toLocaleTimeString())} ${text}`)
  }
}

/**
 * Follow the owner's HEAD until interrupted, then release. Gives up without
 * releasing if someone else takes the focus worktree over: it is no longer
 * this watcher's to release.
 */
async function watch(
  repo: RepoContext,
  config: FocusConfig,
  moved: MoveResult,
  interval: number,
  options: FocusOptions,
): Promise<void> {
  const owner = moved.owner
  const name = basename(owner.worktree)
  event('focused', { path: moved.path, worktree: owner.worktree, commit: moved.commit },
    `Focused ${pc.cyan(name)} at ${moved.commit.slice(0, 8)}; watching for commits (Ctrl-C to stop and release)`)

  let stopping = false
  let wake: () => void = () => {}
  const stop = () => {
    // A second signal means "now": skip the release.
    if (stopping) process.exit(130)
    stopping = true
    wake()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  // A commit that failed to apply is not retried until the owner moves on,
  // so a broken hook does not rerun every interval.
  let failed: string | undefined
  try {
    while (!stopping) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval)
        wake = () => { clearTimeout(timer); resolve() }
      })
      if (stopping) break

      const state = await readFocusState(repo.rootWorktree)
      if (!state?.owner || !samePath(state.owner.worktree, owner.worktree)) {
        event('lost', { owner: state?.owner ?? null },
          state?.owner
            ? pc.yellow(`${basename(state.owner.worktree)} took the focus worktree over; stopping`)
            : pc.yellow('The focus worktree was released; stopping'))
        return
      }
      if (!existsSync(owner.worktree)) {
        event('lost', { owner: null }, pc.yellow(`${name} no longer exists; stopping`))
        break
      }

      const head = await headOf(owner.worktree)
      if (head === state.commit || head === failed) continue
      try {
        await moveFocus(repo, config, owner, head, options, { activate: false })
        failed = undefined
        event('pulled', { from: state.commit, to: head },
          `Pulled ${state.commit.slice(0, 8)} → ${pc.green(head.slice(0, 8))}`)
      } catch (error) {
        failed = head
        const err = error instanceof WtError ? error : new WtError(String(error))
        event('error', { code: err.code, message: err.message, hint: err.hint ?? null },
          pc.yellow(`Could not pull ${head.slice(0, 8)}: ${err.message}${err.hint ? ` ${pc.dim(err.hint)}` : ''}`))
      }
    }

    const state = await readFocusState(repo.rootWorktree)
    if (state?.owner && samePath(state.owner.worktree, owner.worktree)) {
      await release(repo, config, state, options)
      event('released', { owner, commit: state.commit },
        `Released ${pc.cyan(name)}; ${basename(state.path)} stays at ${state.commit.slice(0, 8)}`)
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

async function release(
  repo: RepoContext,
  config: FocusConfig,
  state: FocusState,
  options: FocusOptions,
): Promise<void> {
  await runFocusHooks('release', config, {
    rootWorktree: repo.rootWorktree,
    focusPath: state.path,
    owner: state.owner,
    from: state.commit,
    to: null,
  }, hookOptions(options))
  await writeFocusState(repo.rootWorktree, { ...state, owner: null, updatedAt: new Date().toISOString() })
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
    dirty: exists ? await hasFocusChanges(state!.path, config) : false,
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

  await release(repo, config, state, options)

  if (getOutputContext().json) {
    emitJson({ ok: true, released: true, owner: state.owner, path: state.path, commit: state.commit })
    return
  }
  success(`Released ${pc.cyan(basename(state.owner.worktree))}; ${basename(state.path)} stays at ${state.commit.slice(0, 8)}`)
}
