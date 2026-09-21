import { Command } from 'commander'
import pc from 'picocolors'
import { basename, dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, rename, rmdir } from 'node:fs/promises'
import {
  loadConfig,
  expandHome,
  profileList,
  getProfile,
  profileForPath,
  codeDirFor,
  type ResolvedProfile,
  type GroveConfig,
} from '../core/config.js'
import {
  registryIdentifierProblem,
  validateRegistryIdentifier,
  writeRepo,
} from '../core/registry.js'
import { git, isGitRepo, listWorktrees } from '../core/git.js'
import { canonical, samePath } from '../core/paths.js'
import { optionalText, select, confirm, canPrompt } from '../core/prompts.js'
import { emitJson, emitCd, log, success, info, warn, getOutputContext } from '../core/output.js'
import { WtError, NeedsInputError } from '../core/errors.js'

export function importCommand(): Command {
  return new Command('import')
    .description('Adopt an existing local git repo into the worktree layout')
    .argument('<path>', 'path to the repo, or to its worktree parent directory')
    .argument('[name]', 'name to register (default: derived from the directory)')
    .option('-a, --alias <alias>', 'short alias for the repo')
    .option('--no-alias', 'skip the alias prompt')
    .option('--restructure', 'move the repo into a main/ subfolder without asking')
    .option('--no-restructure', 'register as-is, leaving the layout alone')
    .option(
      '-p, --profile <name>',
      'move the repo under this profile\'s directory before registering',
    )
    .option('--dir <path>', 'explicit parent directory to move the repo into')
    .action(async (path, nameArg, options) => {
      await runImport(path, nameArg, options)
    })
}

interface ImportOptions {
  alias?: string | false
  restructure?: boolean
  profile?: string
  dir?: string
}

/** What we found at the path the user pointed us at. */
type Layout =
  /** `<path>/main` is the checkout — already the layout grove wants. */
  | { kind: 'worktree-parent'; repoParent: string; mainPath: string }
  /** `<path>` is itself a checkout, and needs moving down into `main/`. */
  | { kind: 'plain-clone'; repoParent: string; mainPath: string }

async function detectLayout(path: string): Promise<Layout> {
  const mainDir = join(path, 'main')
  if (existsSync(mainDir) && (await isGitRepo(mainDir))) {
    return { kind: 'worktree-parent', repoParent: path, mainPath: mainDir }
  }

  if (await isGitRepo(path)) {
    // Guard against pointing at a subdirectory of a checkout: the repo root is
    // what gets moved, and moving from halfway down would shred the clone.
    const { stdout } = await git(['rev-parse', '--show-toplevel'], { cwd: path })
    if (stdout && !samePath(stdout, path)) {
      throw new WtError(`${path} is inside a git repo, not its root.`, {
        code: 'not_repo_root',
        hint: `Import the repo root instead: \`grove import ${stdout}\`.`,
      })
    }
    // Pointed straight at the checkout of an already-correct layout: register
    // the parent, which is what holds the worktrees.
    if (basename(path) === 'main') {
      return { kind: 'worktree-parent', repoParent: dirname(path), mainPath: path }
    }
    return { kind: 'plain-clone', repoParent: path, mainPath: join(path, 'main') }
  }

  throw new WtError(`Not a git repo: ${path}`, {
    code: 'not_a_repo',
    hint: 'Point at a git repo, or a directory containing a `main` checkout.',
  })
}

/**
 * Move `<path>` down into `<path>/main`.
 *
 * Done by staging the checkout at a sibling first: renaming a directory into
 * its own child is not a legal move, so the contents take the scenic route.
 * The sibling is a fresh name next to the repo, which keeps the move on one
 * filesystem — and therefore atomic-ish — where copying through a temp dir
 * elsewhere would not be.
 */
async function restructureIntoMain(repoParent: string): Promise<string> {
  const staging = await freeSiblingPath(repoParent)
  const mainPath = join(repoParent, 'main')

  await rename(repoParent, staging)
  try {
    await mkdir(repoParent, { recursive: true })
    await rename(staging, mainPath)
  } catch (error) {
    // Put it back rather than leaving the repo parked under a temp name.
    if (existsSync(staging)) {
      if (existsSync(repoParent)) await rmdir(repoParent).catch(() => {})
      await rename(staging, repoParent).catch(() => {})
    }
    throw error
  }
  return mainPath
}

/** An unused path next to `path`, for staging a rename through. */
async function freeSiblingPath(path: string): Promise<string> {
  const parent = dirname(path)
  const name = basename(path)
  for (let i = 0; i < 100; i += 1) {
    const candidate = join(parent, `.${name}.grove-import${i === 0 ? '' : `-${i}`}`)
    if (!existsSync(candidate)) return candidate
  }
  throw new WtError(`Could not find a free staging path next to ${path}.`, {
    code: 'no_staging_path',
  })
}

/**
 * Worktrees record their repo's path in `.git` files and in the repo's own
 * worktree metadata, and none of that survives moving the checkout. Refuse
 * rather than silently breaking them.
 */
async function assertNoLinkedWorktrees(mainPath: string): Promise<void> {
  const worktrees = await listWorktrees(mainPath)
  const linked = worktrees.filter((worktree) => !samePath(worktree.path, mainPath))
  if (linked.length === 0) return

  throw new WtError(
    `${mainPath} has ${linked.length} linked worktree${linked.length === 1 ? '' : 's'}, which moving it would break.`,
    {
      code: 'has_linked_worktrees',
      hint: `Remove them first (${linked
        .map((worktree) => basename(worktree.path))
        .join(', ')}), or import with --no-restructure to register it as it is.`,
    },
  )
}

/** Pick the profile to move an out-of-profile repo into. */
async function chooseTargetProfile(
  config: GroveConfig,
  requested: string | undefined,
): Promise<ResolvedProfile | undefined> {
  if (requested) return getProfile(config, requested)

  const profiles = profileList(config)
  if (profiles.length === 0) return undefined
  if (profiles.length === 1) return profiles[0]

  return getProfile(
    config,
    await select(
      'Which profile should this repo move into?',
      profiles.map((profile) => ({
        value: profile.name,
        label: profile.name,
        hint: profile.description ?? profile.dir,
      })),
      'A profile name',
    ),
  )
}

async function runImport(
  pathArg: string,
  nameArg: string | undefined,
  options: ImportOptions,
): Promise<void> {
  const config = await loadConfig()
  const path = resolve(expandHome(pathArg))

  if (!existsSync(path)) {
    throw new WtError(`Path does not exist: ${path}`, { code: 'no_such_path' })
  }

  const repoName = nameArg ?? deriveName(path)
  validateRegistryIdentifier(repoName)
  if (typeof options.alias === 'string') {
    validateRegistryIdentifier(options.alias)
  }

  const layout = await detectLayout(path)
  let repoParent = layout.repoParent
  let mainPath = layout.mainPath
  let restructured = false
  let moved = false

  // 1. Warn about — and offer to fix — a repo that is not in <repo>/main.
  if (layout.kind === 'plain-clone') {
    warn(`${path} is a plain clone, not a ${pc.cyan('<repo>/main')} worktree layout.`)
    log(
      pc.dim(
        `  Grove keeps the primary checkout in main/ so sibling directories can be worktrees.`,
      ),
    )

    const shouldRestructure = await decideRestructure(options.restructure, repoName)
    if (shouldRestructure) {
      await assertNoLinkedWorktrees(path)
      info(`Moving ${path} → ${join(path, 'main')}...`)
      mainPath = await restructureIntoMain(repoParent)
      restructured = true
    } else {
      // Registering a plain clone is supported (gitDirFor falls back to the
      // path itself), it just cannot host worktrees as siblings.
      mainPath = path
    }
  }

  // 2. Optionally relocate the repo under a profile directory.
  const currentProfile = profileForPath(config, repoParent)
  const wantsMove = options.dir !== undefined || options.profile !== undefined
  if (wantsMove || (!currentProfile && canPrompt() && !getOutputContext().json)) {
    const target = await resolveMoveTarget(config, repoParent, repoName, options, wantsMove)
    if (target && !samePath(target, repoParent)) {
      if (existsSync(target)) {
        throw new WtError(`Already exists: ${target}`, { code: 'move_target_exists' })
      }
      if (restructured || layout.kind === 'worktree-parent') {
        await assertNoLinkedWorktrees(mainPath)
      }
      info(`Moving ${repoParent} → ${target}...`)
      await mkdir(dirname(target), { recursive: true })
      // Whether the checkout is the folder itself or its main/ child, it keeps
      // its position relative to the folder being moved.
      const mainIsChild = !samePath(mainPath, repoParent)
      await rename(repoParent, target)
      mainPath = mainIsChild ? join(target, basename(mainPath)) : target
      repoParent = target
      moved = true
    }
  }

  // Re-read the profile: a move may have changed which one owns the path.
  const profile = profileForPath(config, repoParent)

  // 3. Register.
  let alias: string | undefined
  if (options.alias === false) {
    alias = undefined
  } else if (typeof options.alias === 'string') {
    alias = options.alias
  } else {
    alias = await optionalText(undefined, {
      message: `Short alias for "${repoName}"? (optional)`,
      placeholder: repoName.slice(0, 3),
      validate: registryIdentifierProblem,
    })
  }

  await writeRepo(config.reposFile, repoName, repoParent, alias)

  // Base-branch detection reads origin/HEAD; set it now while we are here so
  // the first `grove new` does not have to fail first.
  await git(['remote', 'set-head', 'origin', '--auto'], {
    cwd: mainPath,
    allowFailure: true,
  })

  if (getOutputContext().json) {
    emitJson({
      ok: true,
      name: repoName,
      alias: alias ?? null,
      profile: profile?.name ?? null,
      path: repoParent,
      mainPath,
      restructured,
      moved,
    })
    return
  }

  log()
  success(`Imported ${pc.cyan(repoName)} → ${repoParent}`)
  if (restructured) log(pc.dim(`  Checkout moved into ${mainPath}`))
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
  emitCd(mainPath)
}

/**
 * Decide whether to move the checkout into main/. Non-interactive runs must
 * say so explicitly: restructuring moves the user's files, which is not
 * something to do by assumption.
 */
async function decideRestructure(
  requested: boolean | undefined,
  repoName: string,
): Promise<boolean> {
  if (requested !== undefined) return requested
  if (!canPrompt()) {
    throw new NeedsInputError(
      `A layout decision for "${repoName}"`,
      '--restructure to move it into main/, or --no-restructure to register it as-is',
    )
  }
  return confirm('Move it into a main/ subfolder now?', {
    assumeYes: false,
    defaultValue: true,
    what: 'A layout decision',
  })
}

/**
 * Where the repo folder should end up, or undefined to leave it be. Explicit
 * --dir/--profile are obeyed; otherwise this is the interactive offer made for
 * a repo sitting outside every configured profile.
 */
async function resolveMoveTarget(
  config: GroveConfig,
  repoParent: string,
  repoName: string,
  options: ImportOptions,
  explicit: boolean,
): Promise<string | undefined> {
  if (options.dir !== undefined) {
    return join(resolve(expandHome(options.dir)), repoName)
  }
  if (options.profile !== undefined) {
    return join(getProfile(config, options.profile).dir, repoName)
  }
  if (explicit) return undefined

  // Offer only when there is somewhere meaningful to move it to.
  const profiles = profileList(config)
  const fallback = canonical(config.defaultCodeDir)
  if (profiles.length === 0 && samePath(dirname(repoParent), fallback)) {
    return undefined
  }

  const wants = await confirm(
    `${repoParent} is outside your grove directories. Move it in?`,
    { assumeYes: false, defaultValue: false, what: 'A move decision' },
  )
  if (!wants) return undefined

  const profile = await chooseTargetProfile(config, undefined)
  return join(codeDirFor(config, profile), repoName)
}

/**
 * Name the repo after its directory — but a path ending in `main/` names the
 * repo after the parent, since that is the worktree layout's own naming.
 */
function deriveName(path: string): string {
  const name = basename(path)
  if (name === 'main') {
    const parent = basename(dirname(path))
    if (parent) return parent
  }
  return name
}
