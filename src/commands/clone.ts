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
  profileForUrl,
  profileBlocksUrl,
  codeDirFor,
  type ResolvedProfile,
  type GroveConfig,
} from '../core/config.js'
import { writeRepo } from '../core/registry.js'
import { repoNameFromUrl } from '../core/naming.js'
import { git } from '../core/git.js'
import { optionalText, select, canPrompt } from '../core/prompts.js'
import { emitJson, emitCd, log, success, info, getOutputContext } from '../core/output.js'
import { WtError, NeedsInputError } from '../core/errors.js'

export function cloneCommand(): Command {
  return new Command('clone')
    .description('Clone a repo into a worktree layout and register it')
    .argument('<url>', 'git clone URL')
    .argument('[name]', 'name to register (default: derived from the URL)')
    .option('-p, --profile <name>', 'profile whose directory to clone into')
    .option('-a, --alias <alias>', 'short alias for the repo')
    .option('--no-alias', 'skip the alias prompt')
    .option('--dir <path>', 'explicit parent directory, overriding the profile')
    .action(async (url, nameArg, options) => {
      await runClone(url, nameArg, options)
    })
}

interface CloneOptions {
  profile?: string
  alias?: string | false
  dir?: string
}

/**
 * Decide which profile a clone belongs to:
 *   --profile wins, then a host match, then the configured default, then a
 *   prompt when several exist and we can ask.
 */
async function chooseProfile(
  config: GroveConfig,
  url: string,
  requested: string | undefined,
): Promise<ResolvedProfile | undefined> {
  if (requested) return getProfile(config, requested)

  const profiles = profileList(config)
  if (profiles.length === 0) return undefined

  const byHost = profileForUrl(config, url)
  if (byHost) {
    info(`Profile ${pc.cyan(byHost.name)} matched the clone URL.`)
    return byHost
  }

  if (profiles.length === 1) return profiles[0]

  if (config.defaultProfile) {
    return getProfile(config, config.defaultProfile)
  }

  if (!canPrompt()) {
    throw new NeedsInputError(
      `A profile is required (${profiles.length} configured, none matched the URL)`,
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

async function runClone(
  url: string,
  nameArg: string | undefined,
  options: CloneOptions,
): Promise<void> {
  const config = await loadConfig()
  const repoName = nameArg ?? repoNameFromUrl(url)

  const profile = options.dir
    ? undefined
    : await chooseProfile(config, url, options.profile)

  // A profile that blocks a host should not silently accept a repo from it.
  if (profile) {
    const blocked = profileBlocksUrl(profile, url)
    if (blocked) {
      throw new WtError(
        `Profile "${profile.name}" blocks ${blocked}, but the clone URL points there.`,
        {
          code: 'profile_blocks_host',
          hint: 'Clone into a different profile with --profile, or adjust the profile.',
        },
      )
    }
  }

  const baseDir = options.dir
    ? resolve(expandHome(options.dir))
    : codeDirFor(config, profile)

  // Layout: <baseDir>/<repo>/main is the primary checkout; sibling
  // directories become worktrees.
  const repoParent = join(baseDir, repoName)
  const cloneTarget = join(repoParent, 'main')

  if (existsSync(cloneTarget)) {
    throw new WtError(`Already exists: ${cloneTarget}`, {
      code: 'clone_target_exists',
      hint: `Register it instead with \`grove repos add ${repoParent}\`.`,
    })
  }

  info(`Cloning into ${cloneTarget}...`)
  await mkdir(repoParent, { recursive: true })
  await git(['clone', url, cloneTarget], { stream: true })

  // Ensure origin/HEAD is set so base-branch detection works later.
  await git(['remote', 'set-head', 'origin', '--auto'], {
    cwd: cloneTarget,
    allowFailure: true,
  })

  let alias: string | undefined
  if (options.alias === false) {
    alias = undefined
  } else if (typeof options.alias === 'string') {
    alias = options.alias
  } else {
    alias = await optionalText(undefined, {
      message: `Short alias for "${repoName}"? (optional)`,
      placeholder: repoName.slice(0, 3),
    })
  }

  await writeRepo(config.reposFile, repoName, repoParent, alias)

  if (getOutputContext().json) {
    emitJson({
      ok: true,
      name: repoName,
      alias: alias ?? null,
      profile: profile?.name ?? null,
      path: repoParent,
      mainPath: cloneTarget,
    })
    return
  }

  log()
  success(`Cloned ${pc.cyan(repoName)} → ${cloneTarget}`)
  if (profile) {
    log(pc.dim(`  Profile: ${profile.name}`))
    for (const rule of profile.rules ?? []) {
      log(pc.dim(`  Rule: ${rule}`))
    }
  }
  log(
    pc.dim(
      `  Registered as "${repoName}"${alias ? ` and "${alias}"` : ''} in ${config.reposFile}`,
    ),
  )
  log(pc.dim(`  Next: wt new ${alias ?? repoName} "my task"`))
  emitCd(cloneTarget)
}
