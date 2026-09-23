import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WtError } from './errors.js'

const execFileAsync = promisify(execFile)

export type Visibility = 'private' | 'public' | 'internal'

export const VISIBILITIES: Visibility[] = ['private', 'public', 'internal']

export function isVisibility(value: string): value is Visibility {
  return (VISIBILITIES as string[]).includes(value)
}

/**
 * Whether `gh` can actually create a repo right now.
 *
 * `gh auth status` exits 0 whenever an account is *configured*, even when its
 * token is expired or rejected by the keyring — so the exit code alone would
 * let us offer a prompt that then fails. The per-account failure lines are
 * what distinguish "logged in" from "has an account on file", so they are
 * what we check.
 */
export async function ghStatus(): Promise<
  { available: true } | { available: false; reason: string }
> {
  // Escape hatch for tests and for anyone who never wants grove shelling out
  // to gh. Without it, whether `create` contacts GitHub would depend on the
  // machine's login state, which makes the test suite's behaviour ambient.
  if (process.env['GROVE_NO_GITHUB'] === '1') {
    return { available: false, reason: 'GitHub integration is disabled (GROVE_NO_GITHUB=1)' }
  }

  let output: string
  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'])
    output = `${stdout}${stderr}`
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    if (err.code === 'ENOENT') {
      return { available: false, reason: 'the GitHub CLI (gh) is not installed' }
    }
    // Any non-zero exit means no usable account at all.
    return { available: false, reason: 'gh is not logged in (`gh auth login`)' }
  }

  if (/Failed to log in|token .*(invalid|expired)|not logged in/i.test(output)) {
    return {
      available: false,
      reason: 'the gh token is invalid or expired (`gh auth refresh`)',
    }
  }
  return { available: true }
}

export interface CreateRepoOptions {
  name: string
  /** Local checkout to attach as the remote's source. */
  source: string
  visibility: Visibility
  /** Owner/org to create under; defaults to the authenticated user. */
  owner?: string
}

export interface CreatedRepo {
  /** Full name as GitHub reports it, e.g. "owner/repo". */
  nameWithOwner: string
  url: string
}

/**
 * Create the repo on GitHub and wire it up as `origin`.
 *
 * Nothing is pushed: a freshly created grove repo has no commits, and `gh`'s
 * own `--push` would fail on an unborn HEAD.
 */
export async function createGithubRepo(
  options: CreateRepoOptions,
): Promise<CreatedRepo> {
  const target = options.owner ? `${options.owner}/${options.name}` : options.name
  const args = [
    'repo',
    'create',
    target,
    `--${options.visibility}`,
    '--source',
    options.source,
    '--remote',
    'origin',
  ]

  try {
    await execFileAsync('gh', args)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string }
    const detail = (err.stderr ?? err.stdout ?? '').trim().split('\n').at(-1) ?? ''
    throw new WtError(
      `Could not create the GitHub repo${detail ? `: ${detail}` : '.'}`,
      {
        code: 'gh_create_failed',
        // The local repo is already usable, so this is not a dead end.
        hint: `The local repo at ${options.source} was created and registered. Add a remote yourself, or retry with \`gh repo create ${target} --${options.visibility} --source ${options.source} --remote origin\`.`,
      },
    )
  }

  // Read back what was actually created rather than assuming the target name:
  // gh resolves a bare name against the authenticated user.
  const { stdout } = await execFileAsync('gh', [
    'repo',
    'view',
    target,
    '--json',
    'nameWithOwner,url',
  ])
  const parsed = JSON.parse(stdout) as CreatedRepo
  return parsed
}
