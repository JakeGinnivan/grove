#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { setOutputContext, reportError, warn } from './core/output.js'
import { CancelledError } from './core/errors.js'
import { newCommand } from './commands/new.js'
import { checkoutCommand } from './commands/checkout.js'
import { listCommand } from './commands/list.js'
import { pickCommand } from './commands/pick.js'
import { reposCommand } from './commands/repos.js'
import { cloneCommand } from './commands/clone.js'
import { importCommand } from './commands/import.js'
import { createCommand } from './commands/create.js'
import { cleanupCommand } from './commands/cleanup.js'
import { syncCommand } from './commands/sync.js'
import { setupCommand } from './commands/setup.js'
import { outdatedSkillTargets, skillsCommand } from './commands/skills.js'
import { updateCommand } from './commands/update.js'
import { shellInitCommand } from './commands/shell-init.js'
import { profileCommand } from './commands/profile.js'
import { completeCommand } from './commands/complete.js'
import { portCommand } from './commands/port.js'
import { focusCommand } from './commands/focus.js'

// package.json is the single source of truth for the version; changesets bumps
// it and nothing else needs updating. npm always ships it next to the bundle,
// so dist/cli.mjs finds it one directory up.
const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
).version as string

function buildProgram(): Command {
  const program = new Command('grove')
    .description('Git worktree manager')
    // commander defaults to -V; nothing here uses -v for verbosity.
    .version(VERSION, '-v, --version')
    // Documented here for `--help`; parsed out of argv before commander runs
    // so they can appear after the subcommand too.
    .option('--json', 'emit machine-readable JSON (implies --no-interactive)')
    .option('--no-interactive', 'never prompt; fail if input is missing')
    // Lets a subcommand enable positional options for its own subcommands:
    // commander only honours that when every ancestor enables it too. The
    // global options above are stripped from argv first, so they still work
    // after the subcommand.
    .enablePositionalOptions()
    .showHelpAfterError()
    .hook('postAction', async (_program, action) => {
      await warnIfSkillsOutdated(topLevelName(action))
    })

  program.addCommand(newCommand())
  program.addCommand(checkoutCommand())
  program.addCommand(listCommand())
  program.addCommand(pickCommand())
  program.addCommand(syncCommand())
  program.addCommand(cleanupCommand())
  program.addCommand(portCommand())
  program.addCommand(focusCommand())
  program.addCommand(cloneCommand())
  program.addCommand(importCommand())
  program.addCommand(createCommand())
  program.addCommand(reposCommand())
  program.addCommand(profileCommand())
  program.addCommand(skillsCommand())
  program.addCommand(updateCommand())
  program.addCommand(setupCommand())
  program.addCommand(shellInitCommand())
  program.addCommand(completeCommand(), { hidden: true })

  return program
}

function topLevelName(command: Command): string {
  let current = command
  while (current.parent?.parent) current = current.parent
  return current.name()
}

/**
 * Commands that manage skills or the shell report on them already, and
 * completion and shell-init output must stay free of anything extra.
 */
const NO_SKILLS_CHECK = new Set(['update', 'skills', 'setup', 'shell-init', '__complete'])

/**
 * Upgrading grove doesn't touch the skill copies it installed for agents, so
 * they quietly drift. A one-line nudge after a command points at the fix.
 */
async function warnIfSkillsOutdated(command: string): Promise<void> {
  if (NO_SKILLS_CHECK.has(command)) return
  try {
    const outdated = await outdatedSkillTargets()
    if (outdated.length === 0) return
    warn(`grove's agent skills are out of date for ${outdated.join(', ')}. Run \`grove update\`.`)
  } catch {
    // The nudge is a courtesy; it must never fail the command it follows.
  }
}

async function main(): Promise<void> {
  // --json and --no-interactive are accepted anywhere on the command line,
  // including after the subcommand, because that is how they read most
  // naturally (`grove list repo --json`). They are stripped before commander
  // parses, so individual commands do not need to redeclare them.
  const argv = process.argv.slice(0, 2)
  let json = false
  let interactive = true
  let literal = false

  for (const arg of process.argv.slice(2)) {
    // Everything after `--` is a literal value, so a title or branch that
    // happens to read like a global flag survives intact.
    if (literal) {
      argv.push(arg)
      continue
    }
    if (arg === '--') {
      literal = true
      argv.push(arg)
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--no-interactive' || arg === '--non-interactive') {
      interactive = false
    } else {
      argv.push(arg)
    }
  }

  // --json implies non-interactive: a prompt would corrupt the JSON stream.
  if (json) interactive = false
  // Piped output cannot host a prompt either.
  if (!process.stdin.isTTY) interactive = false

  setOutputContext({ json, interactive })

  const program = buildProgram()
  await program.parseAsync(argv)
}

main().catch((error: unknown) => {
  if (error instanceof CancelledError) {
    process.exitCode = error.exitCode
    return
  }
  process.exitCode = reportError(error)
})
