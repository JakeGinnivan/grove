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
import { optionalText, select, canPrompt } from '../core/prompts.js'
import { emitJson, emitCd, log, success, info, getOutputContext } from '../core/output.js'
import { WtError, NeedsInputError } from '../core/errors.js'

export function createCommand(): Command {
  return new Command('create')
    .description('Create a new git repo in the worktree layout and register it')
    .argument('<name>', 'repo name; also the directory it is created in')
    .option('-p, --profile <name>', 'profile whose directory to create the repo in')
    .option('-a, --alias <alias>', 'short alias for the repo')
    .option('--no-alias', 'skip the alias prompt')
    .option('--dir <path>', 'explicit parent directory, overriding the profile')
    .option('-b, --branch <name>', 'initial branch name (default: main)')
    .action(async (name, options) => {
      await runCreate(name, options)
    })
}

interface CreateOptions {
  profile?: string
  alias?: string | false
  dir?: string
  branch?: string
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

  if (getOutputContext().json) {
    emitJson({
      ok: true,
      name,
      alias: alias ?? null,
      profile: profile?.name ?? null,
      path: repoParent,
      mainPath,
      branch,
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
  // Worktrees branch from a ref, and a repo with no commits and no remote has
  // none to offer — so both steps are spelled out, including the --base that
  // stands in for the origin/HEAD `new` would otherwise look for.
  log(pc.dim(`  Next: make your first commit in ${mainPath}`))
  log(pc.dim(`        then: wt new ${alias ?? name} "my task" --base ${branch}`))
  emitCd(mainPath)
}
