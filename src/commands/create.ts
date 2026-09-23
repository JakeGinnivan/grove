import { Command } from 'commander'
import pc from 'picocolors'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import {
  loadConfig,
  expandHome,
  profileList,
  getProfile,
  codeDirFor,
  type ResolvedProfile,
  type GroveConfig,
} from '../core/config.js'
import {
  registryIdentifierProblem,
  validateRegistryIdentifier,
  writeRepo,
} from '../core/registry.js'
import { git } from '../core/git.js'
import { optionalText, select, confirm, canPrompt } from '../core/prompts.js'
import { emitJson, emitCd, log, success, info, getOutputContext } from '../core/output.js'
import { WtError, NeedsInputError } from '../core/errors.js'
import {
  ghStatus,
  createGithubRepo,
  isVisibility,
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

/**
 * Decide which profile a new repo belongs to: --profile wins, then the
 * configured default, then a prompt when several exist and we can ask.
 *
 * Mirrors `clone`'s routing — a repo you start locally lands in the same place
 * it would have if you had cloned it.
 */
async function chooseProfile(
  config: GroveConfig,
  requested: string | undefined,
): Promise<ResolvedProfile | undefined> {
  if (requested) return getProfile(config, requested)

  const profiles = profileList(config)
  if (profiles.length === 0) return undefined
  if (profiles.length === 1) return profiles[0]

  if (config.defaultProfile) {
    return getProfile(config, config.defaultProfile)
  }

  if (!canPrompt()) {
    throw new NeedsInputError(
      `A profile is required (${profiles.length} configured, no default set)`,
      `--profile <${profiles.map((p) => p.name).join('|')}>`,
    )
  }

  const chosen = await select(
    'Which profile should this repo live in?',
    profiles.map((profile) => ({
      value: profile.name,
      label: profile.name,
      hint: profile.description ?? profile.dir,
    })),
    'A profile name',
  )
  return getProfile(config, chosen)
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

  const github = await maybeCreateOnGithub(name, mainPath, options)

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

  const visibility = await chooseVisibility(requestedVisibility, explicit)

  info(`Creating ${name} on GitHub (${visibility})...`)
  return createGithubRepo({
    name,
    source: mainPath,
    visibility,
    ...(options.owner ? { owner: options.owner } : {}),
  })
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
