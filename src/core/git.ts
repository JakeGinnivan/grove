import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalize, join, dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { WtError } from './errors.js'

const execFileAsync = promisify(execFile)

export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface GitOptions {
  /** Directory to run in (`git -C`). */
  cwd?: string
  /** Do not throw on a non-zero exit; return the result instead. */
  allowFailure?: boolean
  /** Inherit stdio so git's own progress output reaches the user. */
  stream?: boolean
  env?: NodeJS.ProcessEnv
}

/**
 * Run a git command. Uses execFile (no shell) so branch names, paths, and
 * titles containing spaces or shell metacharacters are passed through safely.
 */
export async function git(
  args: string[],
  options: GitOptions = {},
): Promise<GitResult> {
  const { cwd, allowFailure = false, stream = false, env } = options
  const fullArgs = cwd ? ['-C', cwd, ...args] : args

  if (stream) {
    const code = await new Promise<number>((resolve, reject) => {
      const child = execFile('git', fullArgs, { env })
      child.stdout?.pipe(process.stderr)
      child.stderr?.pipe(process.stderr)
      child.on('error', reject)
      child.on('close', (c) => resolve(c ?? 1))
    })
    if (code !== 0 && !allowFailure) {
      throw new WtError(`git ${args.join(' ')} failed with exit code ${code}`, {
        code: 'git_failed',
      })
    }
    return { stdout: '', stderr: '', exitCode: code }
  }

  try {
    const { stdout, stderr } = await execFileAsync('git', fullArgs, {
      env,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      code?: string | number
    }
    if (err.code === 'ENOENT') {
      throw new WtError('git was not found on PATH.', {
        code: 'git_missing',
        hint: 'Install git and make sure it is available in your PATH.',
      })
    }
    if (allowFailure) {
      return {
        stdout: (err.stdout ?? '').trim(),
        stderr: (err.stderr ?? '').trim(),
        exitCode: typeof err.code === 'number' ? err.code : 1,
      }
    }
    const detail = (err.stderr ?? err.message).trim()
    throw new WtError(`git ${args.join(' ')} failed: ${detail}`, {
      code: 'git_failed',
    })
  }
}

/** True when `dir` is inside a git working tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  const { stdout } = await git(['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
    allowFailure: true,
  })
  return stdout === 'true'
}

export interface Worktree {
  path: string
  head: string | undefined
  branch: string | undefined
  bare: boolean
  detached: boolean
  locked: boolean
}

/** Parse `git worktree list --porcelain` into structured entries. */
export async function listWorktrees(gitDir: string): Promise<Worktree[]> {
  const { stdout } = await git(['worktree', 'list', '--porcelain'], {
    cwd: gitDir,
  })
  const worktrees: Worktree[] = []
  let current: Partial<Worktree> | undefined

  const flush = () => {
    if (current?.path) {
      worktrees.push({
        path: current.path,
        head: current.head,
        branch: current.branch,
        bare: current.bare ?? false,
        detached: current.detached ?? false,
        locked: current.locked ?? false,
      })
    }
    current = undefined
  }

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      // git reports paths with forward slashes even on Windows. Normalise to
      // the platform separator so these compare equal to paths we build with
      // node:path, which callers do when matching a worktree by path.
      current = { path: normalize(line.slice('worktree '.length)) }
    } else if (!current) {
      continue
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'detached') {
      current.detached = true
    } else if (line.startsWith('locked')) {
      current.locked = true
    }
  }
  flush()
  return worktrees
}

/**
 * Committer time (unix seconds) of each commit, keyed by full sha. Unknown
 * or unborn heads are simply absent from the result.
 */
export async function commitTimes(
  gitDir: string,
  shas: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(shas)].filter((sha) => !/^0+$/.test(sha))
  const times = new Map<string, number>()
  if (unique.length === 0) return times
  const { stdout } = await git(['show', '-s', '--format=%H %ct', ...unique], {
    cwd: gitDir,
    allowFailure: true,
  })
  for (const line of stdout.split('\n')) {
    const [sha, time] = line.split(' ')
    if (sha && time) times.set(sha, Number(time))
  }
  return times
}

/**
 * Detect the default remote branch, e.g. `origin/main`.
 * Tries origin/HEAD, then falls back to probing common names.
 */
export async function defaultBase(gitDir: string): Promise<string> {
  const symbolic = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd: gitDir,
    allowFailure: true,
  })
  if (symbolic.stdout.startsWith('refs/remotes/')) {
    return symbolic.stdout.slice('refs/remotes/'.length)
  }

  for (const branch of ['main', 'master', 'develop', 'trunk']) {
    if (await remoteBranchExists(gitDir, branch)) {
      return `origin/${branch}`
    }
  }

  throw new WtError('Could not detect the default base branch.', {
    code: 'no_default_base',
    hint: 'Run `git remote set-head origin --auto` in the repo, or pass --base.',
  })
}

/** True when the branch or ref exists locally. */
export async function refExists(gitDir: string, ref: string): Promise<boolean> {
  const { stdout } = await git(['rev-parse', '--verify', '--quiet', ref], {
    cwd: gitDir,
    allowFailure: true,
  })
  return stdout.length > 0
}

export async function localBranchExists(
  gitDir: string,
  branch: string,
): Promise<boolean> {
  return refExists(gitDir, `refs/heads/${branch}`)
}

export async function remoteBranchExists(
  gitDir: string,
  branch: string,
  remote = 'origin',
): Promise<boolean> {
  return refExists(gitDir, `refs/remotes/${remote}/${branch}`)
}

export async function currentBranch(dir: string): Promise<string | undefined> {
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: dir,
    allowFailure: true,
  })
  return stdout && stdout !== 'HEAD' ? stdout : undefined
}

export async function isDirty(dir: string): Promise<boolean> {
  const { stdout } = await git(['status', '--porcelain'], {
    cwd: dir,
  })
  return stdout.length > 0
}

export async function upstreamOf(dir: string): Promise<string | undefined> {
  // A configured upstream first. Without one, where `git push` would send
  // the branch (`@{push}`), then a same-named branch on origin: pushing from
  // the sandbox cannot record an upstream, because that means writing
  // `.git/config`, but the branch is still pushed.
  for (const rev of ['@{u}', '@{push}']) {
    const { stdout, exitCode } = await git(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', rev],
      { cwd: dir, allowFailure: true },
    )
    // When the remote branch is gone (deleted on merge, then pruned) git
    // exits non-zero but still echoes the literal rev on stdout. Trusting
    // stdout alone hands that back as if it were a real ref name.
    if (exitCode === 0 && stdout) return stdout
  }
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: dir,
    allowFailure: true,
  })
  if (branch.exitCode !== 0 || !branch.stdout) return undefined
  const remote = `origin/${branch.stdout}`
  const exists = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`], {
    cwd: dir,
    allowFailure: true,
  })
  return exists.exitCode === 0 ? remote : undefined
}

/** Number of commits in `dir` HEAD that are not in `upstream`. */
export async function aheadCount(
  dir: string,
  upstream: string,
): Promise<number> {
  const { stdout, exitCode } = await git(
    ['rev-list', '--count', `${upstream}..HEAD`],
    { cwd: dir, allowFailure: true },
  )
  // An upstream that no longer resolves is not worth failing the whole
  // listing over — report the branch as not-ahead and let the caller carry on.
  if (exitCode !== 0) return 0
  const count = Number.parseInt(stdout, 10)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new WtError(`git returned an invalid ahead count: ${stdout}`, {
      code: 'git_invalid_output',
    })
  }
  return count
}

/** True when `ref` is fully contained in `base` (i.e. merged). */
export async function isMergedInto(
  gitDir: string,
  ref: string,
  base: string,
): Promise<boolean> {
  const { exitCode } = await git(['merge-base', '--is-ancestor', ref, base], {
    cwd: gitDir,
    allowFailure: true,
  })
  return exitCode === 0
}

/**
 * How many commits `base` is ahead of `sha` when `sha` sits on `base`'s own
 * first-parent line, meaning the branch never gained commits of its own
 * (0 when they are the same commit). Undefined when the branch has its own
 * commits, merged or not. Only meaningful once `sha` is known to be an
 * ancestor of `base`: a `sha` ahead of `base` also yields an empty range.
 *
 * Walking base's first parents stops at the first commit `sha` can reach. For
 * a mainline commit that is `sha` itself; for a branch merged in through a
 * merge commit it is the older merge base, so the two cases come apart.
 */
export async function behindOnMainline(
  gitDir: string,
  sha: string,
  base: string,
): Promise<number | undefined> {
  const { stdout, exitCode } = await git(
    ['rev-list', '--first-parent', '--parents', `${sha}..${base}`],
    { cwd: gitDir, allowFailure: true },
  )
  if (exitCode !== 0) return undefined
  if (!stdout) return 0
  const firstParent = stdout.split('\n').at(-1)!.split(' ')[1]
  if (firstParent !== sha) return undefined
  // Count every commit, as `git status` does, not just the first-parent walk.
  const count = await git(['rev-list', '--count', `${sha}..${base}`], { cwd: gitDir })
  return Number.parseInt(count.stdout, 10)
}

/**
 * grove keeps its own state in a config file of its own inside the git dir,
 * not in `.git/config`: Claude Code's sandbox never lets a command write the
 * repo's config (it could point git at hooks that run outside the sandbox),
 * so state kept there broke every sandboxed `grove new --on` and port
 * assignment. The file is shared by all worktrees, like the git dir itself.
 */
async function groveConfigFile(gitDir: string): Promise<string> {
  const { stdout } = await git(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: gitDir },
  )
  return join(stdout, 'grove', 'config')
}

/**
 * Read a grove setting. Falls back to the repo's git config, which is where
 * older grove versions wrote it and where a user may still set it by hand.
 */
export async function getConfig(
  gitDir: string,
  key: string,
): Promise<string | undefined> {
  const own = await git(['config', '--file', await groveConfigFile(gitDir), '--get', key], {
    cwd: gitDir,
    allowFailure: true,
  })
  if (own.stdout) return own.stdout
  const { stdout } = await git(['config', '--get', key], {
    cwd: gitDir,
    allowFailure: true,
  })
  return stdout || undefined
}

/** Drop a whole section, such as a deleted branch's, from grove's config. */
export async function removeConfigSection(gitDir: string, section: string): Promise<void> {
  await git(['config', '--file', await groveConfigFile(gitDir), '--remove-section', section], {
    cwd: gitDir,
    allowFailure: true,
  })
}

export async function setConfig(
  gitDir: string,
  key: string,
  value: string,
): Promise<void> {
  const file = await groveConfigFile(gitDir)
  await mkdir(dirname(file), { recursive: true })
  await git(['config', '--file', file, key, value], { cwd: gitDir })
}

/** True when this git supports `worktree remove --keep`. */
export async function supportsWorktreeKeep(gitDir: string): Promise<boolean> {
  const { stdout, stderr } = await git(['worktree', 'remove', '-h'], {
    cwd: gitDir,
    allowFailure: true,
  })
  return `${stdout}${stderr}`.includes('--keep')
}

export interface BranchInfo {
  name: string
  /** Where the branch was found. A local branch shadows its remote twin. */
  source: 'local' | 'remote'
  /** Relative age of the branch tip, e.g. "3 days ago". */
  relativeDate: string
  subject: string
}

/**
 * Local branches plus the remote's, most recently committed first.
 *
 * Each branch appears once, under the name a user would type at a `checkout`
 * prompt. A local branch shadows the `<remote>/` ref of the same name because
 * that is what checkout resolves to, regardless of which tip is newer.
 * `<remote>/HEAD` is skipped so the symbolic ref does not surface as a
 * branch called "origin". That filtering happens in the loop below rather
 * than via `for-each-ref --exclude`, which needs git >= 2.42; older git fails
 * the whole command, and `allowFailure` would turn that into an empty list.
 */
export async function listBranches(
  gitDir: string,
  remote = 'origin',
): Promise<BranchInfo[]> {
  const format = [
    '%(refname:short)',
    '%(committerdate:relative)',
    '%(contents:subject)',
  ].join('%09')
  const { stdout } = await git(
    [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=${format}`,
      'refs/heads',
      `refs/remotes/${remote}`,
    ],
    { cwd: gitDir, allowFailure: true },
  )

  const prefix = `${remote}/`
  const byName = new Map<string, BranchInfo>()

  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [ref = '', relativeDate = '', ...rest] = line.split('\t')
    const isRemote = ref.startsWith(prefix)
    const name = isRemote ? ref.slice(prefix.length) : ref
    // `<remote>/HEAD` shortens to bare `<remote>`, so it fails the prefix test
    // above and would otherwise surface as a local branch named "origin".
    if (!name || name === 'HEAD' || ref === remote) continue

    // Refs arrive newest-first, so the first sighting of a name is the one to
    // keep — unless a local ref turns up later for a name first seen on the
    // remote, which takes over as the entry checkout would resolve to.
    const existing = byName.get(name)
    if (existing && (isRemote || existing.source === 'local')) continue

    byName.set(name, {
      name,
      source: isRemote ? 'remote' : 'local',
      relativeDate,
      subject: rest.join('\t'),
    })
  }

  return [...byName.values()]
}
