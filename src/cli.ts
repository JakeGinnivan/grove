#!/usr/bin/env node
import { Command } from 'commander'
import { setOutputContext, reportError } from './core/output.js'
import { CancelledError } from './core/errors.js'
import { newCommand } from './commands/new.js'
import { checkoutCommand } from './commands/checkout.js'
import { listCommand } from './commands/list.js'
import { pickCommand } from './commands/pick.js'
import { reposCommand } from './commands/repos.js'
import { cloneCommand } from './commands/clone.js'
import { cleanupCommand } from './commands/cleanup.js'
import { syncCommand } from './commands/sync.js'
import { setupCommand } from './commands/setup.js'
import { skillsCommand } from './commands/skills.js'
import { shellInitCommand } from './commands/shell-init.js'
import { profileCommand } from './commands/profile.js'
import { completeCommand } from './commands/complete.js'

const VERSION = '0.1.0'

function buildProgram(): Command {
  const program = new Command('grove')
    .description('Git worktree manager')
    .version(VERSION)
    // Documented here for `--help`; parsed out of argv before commander runs
    // so they can appear after the subcommand too.
    .option('--json', 'emit machine-readable JSON (implies --no-interactive)')
    .option('--no-interactive', 'never prompt; fail if input is missing')
    .showHelpAfterError()

  program.addCommand(newCommand())
  program.addCommand(checkoutCommand())
  program.addCommand(listCommand())
  program.addCommand(pickCommand())
  program.addCommand(syncCommand())
  program.addCommand(cleanupCommand())
  program.addCommand(cloneCommand())
  program.addCommand(reposCommand())
  program.addCommand(profileCommand())
  program.addCommand(skillsCommand())
  program.addCommand(setupCommand())
  program.addCommand(shellInitCommand())
  program.addCommand(completeCommand(), { hidden: true })

  return program
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
