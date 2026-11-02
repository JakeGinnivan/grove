import { Command } from 'commander'
import pc from 'picocolors'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import {
  loadConfig,
  saveConfig,
  expandHome,
  codeDirFor,
  type GroveConfig,
} from '../core/config.js'
import {
  readRegistry,
  registryIdentifierProblem,
  validateRegistryIdentifier,
  writeRepo,
} from '../core/registry.js'
import { git } from '../core/git.js'
import {
  optionalText,
  requireText,
  select,
  confirm,
  canPrompt,
  type SelectOption,
} from '../core/prompts.js'
import { emitJson, emitCd, log, success, info, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'
import { chooseProfile } from './shared.js'
import {
  ghStatus,
  createGithubRepo,
  githubOwnerOf,
  groupOwners,
  isVisibility,
  listGithubOwners,
  VISIBILITIES,
  type Visibility,
  type CreatedRepo,
} from '../core/github.js'

export function createCommand(): Command {
  return new Command('create')
    .description('Create a new git repo in the worktree layout and register it')
    .argument('<name>', 'repo name; also the directory it is created in')
    .option('-p, --profile <name>', 'profile whose directory to create the repo in')
    .option('-a, --alias <alias>', 'short alias for the repo')
    .option('--no-alias', 'skip the alias prompt')
    .option('--dir <path>', 'explicit parent directory, overriding the profile')
    .option('-b, --branch <name>', 'initial branch name (default: main)')
    .option('--github', 'also create the repo on GitHub and wire up origin')
    .option('--no-github', 'skip the GitHub prompt')
    .option(
      '--visibility <level>',
      `GitHub visibility: ${VISIBILITIES.join(', ')} (default: private)`,
    )
    .option('--owner <owner>', 'GitHub user or org to create the repo under')
    .action(async (name, options) => {
      await runCreate(name, options)
    })
}

interface CreateOptions {
  profile?: string
  alias?: string | false
  dir?: string
  branch?: string
  github?: boolean
  visibility?: string
  owner?: string
}

async function runCreate(name: string, options: CreateOptions): Promise<void> {
  const config = await loadConfig()
  validateRegistryIdentifier(name)
  if (typeof options.alias === 'string') {
    validateRegistryIdentifier(options.alias)
  }

  const profile = options.dir
    ? undefined
    : await chooseProfile(config, options.profile)

  const baseDir = options.dir
    ? resolve(expandHome(options.dir))
    : codeDirFor(config, profile)

  // Same layout as clone: <baseDir>/<repo>/main is the primary checkout, and
  // sibling directories become worktrees.
  const repoParent = join(baseDir, name)
  const mainPath = join(repoParent, 'main')

  if (existsSync(mainPath)) {
    throw new WtError(`Already exists: ${mainPath}`, {
      code: 'create_target_exists',
      hint: `Register it instead with \`grove import ${repoParent}\`.`,
    })
  }

  // The checkout directory is named main/, so the branch defaults to `main`
  // too rather than to whatever init.defaultBranch happens to be set to.
  const branch = options.branch ?? 'main'

  info(`Creating ${mainPath}...`)
  await mkdir(mainPath, { recursive: true })
  await git(['init', '--initial-branch', branch, mainPath])

  let alias: string | undefined
  if (options.alias === false) {
    alias = undefined
  } else if (typeof options.alias === 'string') {
    alias = options.alias
  } else {
    alias = await optionalText(undefined, {
      message: `Short alias for "${name}"? (optional)`,
      placeholder: name.slice(0, 3),
      validate: registryIdentifierProblem,
    })
  }

  await writeRepo(config.reposFile, name, repoParent, alias)

  const github = await maybeCreateOnGithub(config, name, mainPath, options)

  if (getOutputContext().json) {
    emitJson({
      ok: true,
      name,
      alias: alias ?? null,
      profile: profile?.name ?? null,
      path: repoParent,
      mainPath,
      branch,
      github: github
        ? { nameWithOwner: github.nameWithOwner, url: github.url }
        : null,
    })
    return
  }

  log()
  success(`Created ${pc.cyan(name)} → ${mainPath}`)
  if (profile) {
    log(pc.dim(`  Profile: ${profile.name}`))
    for (const rule of profile.rules ?? []) {
      log(pc.dim(`  Rule: ${rule}`))
    }
  }
  log(
    pc.dim(
      `  Registered as "${name}"${alias ? ` and "${alias}"` : ''} in ${config.reposFile}`,
    ),
  )
  log(pc.dim(`  Branch: ${branch} (no commits yet)`))
  if (github) {
    log(pc.dim(`  GitHub: ${github.url} (origin)`))
  }
  // Worktrees branch from a ref, and a repo with no commits has none to offer
  // — so the first commit is always step one. Without a remote, `new` also has
  // no origin/HEAD to infer a base from, so that gets spelled out too.
  log(pc.dim(`  Next: make your first commit in ${mainPath}`))
  if (github) {
    log(pc.dim(`        then: git push -u origin ${branch}`))
    log(pc.dim(`        then: wt new ${alias ?? name} "my task"`))
  } else {
    log(pc.dim(`        then: wt new ${alias ?? name} "my task" --base ${branch}`))
  }
  emitCd(mainPath)
}

/**
 * Offer to create the repo on GitHub, when `gh` can actually do it.
 *
 * Failure here is deliberately not fatal: the local repo is already created
 * and registered by this point, and losing that over a network error would be
 * a worse outcome than an unwired remote the user can add later.
 */
async function maybeCreateOnGithub(
  config: GroveConfig,
  name: string,
  mainPath: string,
  options: CreateOptions,
): Promise<CreatedRepo | undefined> {
  if (options.github === false) return undefined

  // Validate before touching gh, so a typo'd flag is not reported as a gh
  // problem — and before the prompt, so it fails fast rather than after asking.
  const requestedVisibility =
    options.visibility === undefined ? undefined : parseVisibility(options.visibility)

  const explicit = options.github === true
  const status = await ghStatus()
  if (!status.available) {
    // Only worth mentioning when they asked for it; otherwise absent `gh` just
    // means the prompt never appears.
    if (explicit) {
      throw new WtError(`Cannot create a GitHub repo: ${status.reason}.`, {
        code: 'gh_unavailable',
        hint: `The local repo at ${mainPath} was created and registered.`,
      })
    }
    return undefined
  }

  if (!explicit) {
    if (!canPrompt()) return undefined
    const wants = await confirm(`Create "${name}" on GitHub too?`, {
      assumeYes: false,
      defaultValue: false,
      what: 'A GitHub decision',
    })
    if (!wants) return undefined
  }

  const owner = await chooseOwner(config, options.owner, explicit)
  const visibility = await chooseVisibility(requestedVisibility, explicit)

  info(`Creating ${owner ? `${owner}/` : ''}${name} on GitHub (${visibility})...`)
  const created = await createGithubRepo({
    name,
    source: mainPath,
    visibility,
    ...(owner ? { owner } : {}),
  })
  await rememberOwner(created.nameWithOwner.split('/')[0])
  return created
}

const RECENT_OWNERS = 10
const OTHER_OWNER = '\u0000other'
const DIVIDER = '\u0000divider'

/**
 * The GitHub owner to create under; undefined means the authenticated user.
 *
 * Your own account comes first, then the orgs you have used, latest first, so
 * the handful that matter are not buried among every org you belong to.
 */
async function chooseOwner(
  config: GroveConfig,
  requested: string | undefined,
  explicit: boolean,
): Promise<string | undefined> {
  if (requested) return requested
  // As with visibility, --github alone does not stop to ask.
  if (explicit || !canPrompt()) return undefined

  const available = await listGithubOwners()
  if (!available) {
    return optionalText(undefined, {
      message: 'GitHub owner? (blank for your account)',
      placeholder: config.recentGithubOwners?.[0] ?? '',
    })
  }

  const { you, used, other } = groupOwners(
    available,
    await registeredRemoteOwners(config),
    config.recentGithubOwners,
  )
  const hint = (localRepos: number) =>
    localRepos === 0 ? undefined : localRepos === 1 ? '1 local repo' : `${localRepos} local repos`
  const options: SelectOption[] = [
    { value: you.owner, label: `${you.owner} (you)`, hint: hint(you.localRepos) },
    ...used.map(({ owner, localRepos }) => ({ value: owner, label: owner, hint: hint(localRepos) })),
    ...(used.length > 0 && other.length > 0
      ? [{ value: DIVIDER, label: '── not used yet ──', disabled: true }]
      : []),
    ...other.map((owner) => ({ value: owner, label: owner })),
    { value: OTHER_OWNER, label: 'Other…', hint: 'type an owner' },
  ]

  // Your own account is the default: a repo created there by mistake is
  // private to you, whereas one in an org is visible to its members.
  const chosen = await select('GitHub owner?', options, 'A GitHub owner', you.owner)
  if (chosen === OTHER_OWNER) {
    return requireText(undefined, {
      message: 'GitHub user or org',
      flag: '--owner',
      what: 'A GitHub owner',
    })
  }
  return chosen
}

/** The GitHub owner of every registered repo's origin, one entry per repo. */
async function registeredRemoteOwners(config: GroveConfig): Promise<string[]> {
  const entries = (await readRegistry(config.reposFile)).filter((e) => !e.aliasOf)
  const owners = await Promise.all(
    entries.map(async ({ path }) => {
      const checkout = existsSync(join(path, 'main')) ? join(path, 'main') : path
      const { stdout } = await git(['config', '--get', 'remote.origin.url'], {
        cwd: checkout,
        allowFailure: true,
      })
      return stdout ? githubOwnerOf(stdout) : undefined
    }),
  )
  return owners.filter((owner): owner is string => owner !== undefined)
}

/** Best effort: a config that cannot be written should not fail a create. */
async function rememberOwner(owner: string | undefined): Promise<void> {
  if (!owner) return
  try {
    const config = await loadConfig({ env: false })
    const recent = config.recentGithubOwners ?? []
    if (recent[0] === owner) return
    const rest = recent.filter((r) => r.toLowerCase() !== owner.toLowerCase())
    await saveConfig({ ...config, recentGithubOwners: [owner, ...rest].slice(0, RECENT_OWNERS) })
  } catch {
    // The default just stays where it was.
  }
}

function parseVisibility(value: string): Visibility {
  if (!isVisibility(value)) {
    throw new WtError(`Invalid visibility: ${value}`, {
      code: 'invalid_visibility',
      hint: `Use one of: ${VISIBILITIES.join(', ')}.`,
    })
  }
  return value
}

/** Visibility for a new GitHub repo, defaulting to the safe option. */
async function chooseVisibility(
  requested: Visibility | undefined,
  explicit: boolean,
): Promise<Visibility> {
  if (requested !== undefined) return requested
  // --github on its own should not stop to ask; private is the safe default
  // for a repo whose contents nobody has reviewed yet.
  if (explicit || !canPrompt()) return 'private'

  const chosen = await select(
    'Visibility?',
    [
      { value: 'private', label: 'Private' },
      { value: 'public', label: 'Public' },
      { value: 'internal', label: 'Internal', hint: 'org-visible' },
    ],
    'A visibility',
  )
  return isVisibility(chosen) ? chosen : 'private'
}
