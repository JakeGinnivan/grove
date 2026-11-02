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

export interface GithubOwners {
  /** The authenticated user's login, i.e. where a bare repo name lands. */
  login: string
  /** Orgs the user belongs to, as GitHub lists them. */
  orgs: string[]
}

/**
 * Who `gh` can create repos under, or undefined when it cannot say.
 *
 * Membership is only visible with the `read:org` scope; without it GitHub
 * returns public memberships alone, so the list can be short. Callers offer
 * free-text entry for that reason.
 */
export async function listGithubOwners(): Promise<GithubOwners | undefined> {
  try {
    const [user, orgs] = await Promise.all([
      execFileAsync('gh', ['api', 'user', '--jq', '.login']),
      execFileAsync('gh', ['api', 'user/orgs', '--paginate', '--jq', '.[].login']),
    ])
    const login = user.stdout.trim()
    if (!login) return undefined
    return { login, orgs: orgs.stdout.split('\n').map((o) => o.trim()).filter(Boolean) }
  } catch {
    return undefined
  }
}

/** The owner segment of a github.com remote URL, in any of git's URL forms. */
export function githubOwnerOf(remoteUrl: string): string | undefined {
  const match = /github\.com[:/]+([^/]+)\/[^/]+?$/.exec(remoteUrl.trim())
  return match?.[1]
}

export interface OwnerGroups {
  /** Owners that already have repos registered locally, best guess first. */
  used: { owner: string; localRepos: number }[]
  other: string[]
}

/**
 * Split the owners `gh` can create under by whether any registered repo's
 * origin already points at them. Remotes are the evidence of use because they
 * exist for every repo, however it got here; owners seen only in remotes are
 * dropped, since a clone of someone else's org is no place to create a repo.
 */
export function groupOwners(
  available: GithubOwners,
  remoteOwners: string[],
  lastUsed?: string,
): OwnerGroups {
  const key = (owner: string) => owner.toLowerCase()
  const counts = new Map<string, number>()
  for (const owner of remoteOwners) {
    counts.set(key(owner), (counts.get(key(owner)) ?? 0) + 1)
  }

  const seen = new Set<string>()
  const owners = [available.login, ...available.orgs].filter((owner) => {
    if (seen.has(key(owner))) return false
    seen.add(key(owner))
    return true
  })

  const isLast = (owner: string) => lastUsed !== undefined && key(owner) === key(lastUsed)
  const used = owners
    .filter((owner) => counts.has(key(owner)) || isLast(owner))
    .map((owner) => ({ owner, localRepos: counts.get(key(owner)) ?? 0 }))
    .sort(
      (a, b) =>
        Number(isLast(b.owner)) - Number(isLast(a.owner)) ||
        b.localRepos - a.localRepos ||
        a.owner.localeCompare(b.owner),
    )
  const usedKeys = new Set(used.map((u) => key(u.owner)))
  const other = owners
    .filter((owner) => !usedKeys.has(key(owner)))
    .sort((a, b) =>
      // The personal account stays at the top of the unused group too.
      Number(key(b) === key(available.login)) - Number(key(a) === key(available.login)) ||
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    )
  return { used, other }
}
