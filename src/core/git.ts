import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
      current = { path: line.slice('worktree '.length) }
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
    allowFailure: true,
  })
  return stdout.length > 0
}

export async function upstreamOf(dir: string): Promise<string | undefined> {
  const { stdout } = await git(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd: dir, allowFailure: true },
  )
  return stdout || undefined
}

/** Number of commits in `dir` HEAD that are not in `upstream`. */
export async function aheadCount(
  dir: string,
  upstream: string,
): Promise<number> {
  const { stdout } = await git(['rev-list', '--count', `${upstream}..HEAD`], {
    cwd: dir,
    allowFailure: true,
  })
  return Number.parseInt(stdout, 10) || 0
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

/** Read a git config value, or undefined when unset. */
export async function getConfig(
  gitDir: string,
  key: string,
): Promise<string | undefined> {
  const { stdout } = await git(['config', '--get', key], {
    cwd: gitDir,
    allowFailure: true,
  })
  return stdout || undefined
}

export async function setConfig(
  gitDir: string,
  key: string,
  value: string,
): Promise<void> {
  await git(['config', key, value], { cwd: gitDir })
}

/** True when this git supports `worktree remove --keep`. */
export async function supportsWorktreeKeep(gitDir: string): Promise<boolean> {
  const { stdout, stderr } = await git(['worktree', 'remove', '-h'], {
    cwd: gitDir,
    allowFailure: true,
  })
  return `${stdout}${stderr}`.includes('--keep')
}
