import { Command } from 'commander'
import pc from 'picocolors'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  loadConfig,
  saveConfig,
  profileList,
  getProfile,
  expandHome,
  type Profile,
  type GroveConfig,
} from '../core/config.js'
import {
  planProfileChanges,
  applyChanges,
  profileGitconfigPath,
} from '../core/profile-apply.js'
import { emitJson, log, success, warn, getOutputContext } from '../core/output.js'
import { confirm } from '../core/prompts.js'
import { WtError } from '../core/errors.js'

export function profileCommand(): Command {
  const command = new Command('profile')
    .description('Manage clone profiles (directories with their own policy)')
    .action(async () => {
      await runList()
    })

  command
    .command('list', { isDefault: true })
    .description('List configured profiles')
    .action(async () => {
      await runList()
    })

  command
    .command('add')
    .description('Add or update a profile')
    .argument('<name>', 'profile name, e.g. work or oss')
    .argument('[dir]', 'base directory for clones in this profile')
    .option('-d, --description <text>', 'what belongs in this profile')
    .option(
      '--host <fragment...>',
      'route clone URLs containing this fragment to this profile',
    )
    .option(
      '--block-push <host...>',
      'refuse pushes to these hosts from this profile',
    )
    .option('--rule <text...>', 'policy statement surfaced to agents')
    .option('--default', 'use this profile when none is specified')
    .option('-y, --yes', 'write generated config without confirming')
    .option('--no-apply', 'save the profile without writing git/Claude config')
    .action(async (name, dir, options) => {
      await runAdd(name, dir, options)
    })

  command
    .command('remove')
    .alias('rm')
    .description('Remove a profile (does not touch repositories on disk)')
    .argument('<name>', 'profile name')
    .option('-y, --yes', 'update generated config without confirming')
    .option('--no-apply', 'leave generated git/Claude config untouched')
    .action(async (name, options) => {
      await runRemove(name, options)
    })

  // `add` and `remove` write this config themselves; `apply` exists to
  // re-sync after hand-editing the config file, or on a new machine.
  command
    .command('apply')
    .description('Re-sync generated git and Claude config with the profiles')
    .option('--dry-run', 'show the changes without writing them')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async (options) => {
      await runApply(options)
    })

  return command
}

async function runList(): Promise<void> {
  const config = await loadConfig()
  const profiles = profileList(config)

  if (getOutputContext().json) {
    emitJson({
      ok: true,
      defaultProfile: config.defaultProfile ?? null,
      defaultCodeDir: config.defaultCodeDir,
      profiles: profiles.map((profile) => ({
        name: profile.name,
        dir: profile.dir,
        description: profile.description ?? null,
        hosts: profile.hosts ?? [],
        blockPushTo: profile.blockPushTo ?? [],
        rules: profile.rules ?? [],
        isDefault: config.defaultProfile === profile.name,
      })),
    })
    return
  }

  if (profiles.length === 0) {
    log('No profiles configured.')
    log(pc.dim(`  Clones default to ${config.defaultCodeDir}`))
    log(pc.dim('  Add one with: grove profile add work ~/_code/work'))
    return
  }

  log()
  log(pc.bold('Profiles'))
  for (const profile of profiles) {
    const marker = config.defaultProfile === profile.name ? pc.green(' (default)') : ''
    log(`  ${pc.cyan(profile.name)}${marker}`)
    log(`    ${pc.dim('dir')}      ${profile.dir}`)
    if (profile.description) log(`    ${pc.dim('about')}    ${profile.description}`)
    if (profile.hosts?.length) {
      log(`    ${pc.dim('hosts')}    ${profile.hosts.join(', ')}`)
    }
    if (profile.blockPushTo?.length) {
      log(`    ${pc.dim('no push')}  ${pc.yellow(profile.blockPushTo.join(', '))}`)
    }
    for (const rule of profile.rules ?? []) {
      log(`    ${pc.dim('rule')}     ${rule}`)
    }
  }
  log()
}

interface AddOptions {
  description?: string
  host?: string[]
  blockPush?: string[]
  rule?: string[]
  default?: boolean
  yes?: boolean
  /** commander sets this to false when --no-apply is passed. */
  apply: boolean
}

async function runAdd(
  name: string,
  dirArg: string | undefined,
  options: AddOptions,
): Promise<void> {
  const config = await loadConfig()
  const existing = config.profiles[name]

  if (!dirArg && !existing) {
    throw new WtError(`A directory is required when creating profile "${name}".`, {
      code: 'needs_input',
      exitCode: 2,
      hint: `Run: grove profile add ${name} ~/_code/${name}`,
    })
  }

  const dir = dirArg ? resolve(expandHome(dirArg)) : existing!.dir

  // Merge onto any existing profile so flags can be applied incrementally.
  const profile: Profile = {
    ...existing,
    dir,
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
    ...(options.host ? { hosts: options.host } : {}),
    ...(options.blockPush ? { blockPushTo: options.blockPush } : {}),
    ...(options.rule ? { rules: options.rule } : {}),
  }

  config.profiles[name] = profile
  if (options.default) config.defaultProfile = name
  await saveConfig(config)
  await mkdir(dir, { recursive: true })

  // A profile is only real once its git and Claude config exist, so write
  // them now rather than leaving the user a second command to remember.
  const written = await syncGeneratedConfig(config, {
    skip: options.apply === false,
    assumeYes: options.yes ?? false,
    reason: `Configure profile "${name}"`,
  })

  if (getOutputContext().json) {
    emitJson({
      ok: true,
      profile: { name, ...profile },
      wrote: written,
    })
    return
  }

  success(`${existing ? 'Updated' : 'Added'} profile ${pc.cyan(name)} → ${dir}`)
  for (const file of written) log(pc.dim(`  wrote ${file}`))
  if (options.apply === false && profile.blockPushTo?.length) {
    log(pc.dim('  Run `grove profile apply` to write the git push block.'))
  }
}

/**
 * Bring generated git and Claude config in line with the current profiles.
 *
 * These files live outside the project, so an interactive run confirms before
 * the first write. Agents pass --yes (or --json, which cannot prompt and so
 * requires it) to opt in explicitly.
 */
async function syncGeneratedConfig(
  config: GroveConfig,
  options: {
    skip: boolean
    assumeYes: boolean
    reason: string
    formerProfileDirs?: string[]
  },
): Promise<string[]> {
  if (options.skip) return []

  const changes = await planProfileChanges(config, options.formerProfileDirs)
  const pending = changes.filter((change) => change.changed)
  if (pending.length === 0) return []

  // Under --json there is no prompt to answer, and writing this config is
  // the substance of the command rather than a side effect — silently
  // skipping would leave a profile that does nothing. Opting out is still
  // available via --no-apply.
  const consented = options.assumeYes || getOutputContext().json

  if (!consented) {
    log()
    log(pc.dim(`${options.reason} — files to write:`))
    for (const change of pending) {
      log(pc.dim(`  ${change.file}`))
      log(pc.dim(`    ${change.description}`))
    }
    const proceed = await confirm('Write these files?', {
      assumeYes: false,
      defaultValue: true,
      what: 'Writing git and Claude configuration',
    }).catch((error) => {
      // Non-interactive without --yes: keep the profile, skip the writes,
      // and let the caller tell the user how to finish the job.
      if (error instanceof WtError && error.code === 'needs_input') return false
      throw error
    })
    if (!proceed) return []
  }

  return applyChanges(pending)
}

async function runRemove(
  name: string,
  options: { yes?: boolean; apply: boolean },
): Promise<void> {
  const config = await loadConfig()
  const removed = getProfile(config, name)
  delete config.profiles[name]
  if (config.defaultProfile === name) delete config.defaultProfile
  await saveConfig(config)

  // Refresh so neither the includeIf stanza nor the directory's own managed
  // git block outlives the profile.
  const written = await syncGeneratedConfig(config, {
    skip: options.apply === false,
    assumeYes: options.yes ?? false,
    reason: `Remove profile "${name}" from generated config`,
    formerProfileDirs: [removed.dir],
  })

  if (getOutputContext().json) {
    emitJson({ ok: true, removed: name, wrote: written })
    return
  }
  success(`Removed profile ${name}`)
  for (const file of written) log(pc.dim(`  updated ${file}`))
  log(pc.dim('  Repositories on disk were not touched.'))
}

async function runApply(options: {
  dryRun?: boolean
  yes?: boolean
}): Promise<void> {
  const config = await loadConfig()
  const changes = await planProfileChanges(config)
  const pending = changes.filter((change) => change.changed)

  if (getOutputContext().json) {
    if (!options.dryRun && pending.length > 0) await applyChanges(pending)
    emitJson({
      ok: true,
      dryRun: options.dryRun ?? false,
      changes: changes.map((change) => ({
        file: change.file,
        kind: change.kind,
        description: change.description,
        changed: change.changed,
      })),
    })
    return
  }

  if (changes.length === 0) {
    log('No profiles configured; nothing to apply.')
    return
  }

  log()
  log(pc.bold(options.dryRun ? 'Would write:' : 'Changes to apply:'))
  for (const change of changes) {
    const status = change.changed ? pc.yellow('modify') : pc.dim('up to date')
    log(`  ${status}  ${change.file}`)
    log(`          ${pc.dim(change.description)}`)
  }
  log()

  if (options.dryRun) return
  if (pending.length === 0) {
    log('Everything is already up to date.')
    return
  }

  // These files live outside the project, so confirm before touching them.
  const proceed = await confirm(`Write ${pending.length} file(s)?`, {
    assumeYes: options.yes ?? false,
    defaultValue: true,
    what: 'Writing git and Claude configuration',
  })
  if (!proceed) {
    log('Cancelled.')
    return
  }

  const written = await applyChanges(pending)
  for (const file of written) success(`Wrote ${file}`)

  const blocked = profileList(config).filter((p) => p.blockPushTo?.length)
  if (blocked.length > 0) {
    log()
    log(pc.dim('Push blocking is active for:'))
    for (const profile of blocked) {
      log(pc.dim(`  ${profile.name} → ${profileGitconfigPath(profile)}`))
    }
  }
  const skipped = changes.find((c) => c.description.startsWith('SKIPPED'))
  if (skipped) warn(`${skipped.file}: ${skipped.description}`)
  log()
}
