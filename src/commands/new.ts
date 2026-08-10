import { Command } from 'commander'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor } from '../core/registry.js'
import { generateNames, extractJiraKey } from '../core/naming.js'
import { createWorktree, resolveBase } from '../core/worktree.js'
import { requireText, optionalText, confirm, canPrompt } from '../core/prompts.js'
import { emitJson, emitCd, log, success, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'
import { pickRepo } from './shared.js'
import pc from 'picocolors'

export function newCommand(): Command {
  return new Command('new')
    .description('Create a new worktree with a generated branch name')
    .argument('[repo]', 'registered repo name or alias')
    .argument('[title]', 'short description of the work')
    .option('-t, --title <title>', 'title (alternative to positional argument)')
    .option('-j, --jira <key>', 'Jira issue key, e.g. ABC-123')
    .option('--no-jira', 'skip the Jira prompt entirely')
    .option(
      '--on <branch|worktree>',
      'stack on an existing branch or worktree instead of the default base',
    )
    .option('--base <ref>', 'explicit base ref (default: origin/HEAD)')
    .option('-b, --branch <name>', 'override the generated branch name')
    .option('-d, --dir <name>', 'override the generated worktree directory name')
    .option('--no-fetch', 'skip fetching origin first')
    .option('--no-setup', 'skip repo-defined worktree setup commands')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async (repoArg, titleArg, options) => {
      await runNew(repoArg, titleArg, options)
    })
}

interface NewOptions {
  title?: string
  jira?: string | false
  on?: string
  base?: string
  branch?: string
  dir?: string
  fetch: boolean
  setup: boolean
  yes?: boolean
}

async function runNew(
  repoArg: string | undefined,
  titleArg: string | undefined,
  options: NewOptions,
): Promise<void> {
  const config = await loadConfig()
  const repoName = await pickRepo(config.reposFile, repoArg)
  const repo = await resolveRepo(config.reposFile, repoName)
  const gitDir = await gitDirFor(repo.path)

  const title = await requireText(titleArg ?? options.title, {
    message: 'What are you working on?',
    flag: '--title',
    what: 'A title',
    placeholder: 'fix flaky login test',
  })

  // --no-jira disables the prompt; an explicit --jira wins; otherwise we
  // try to read a key out of the title before asking.
  let jiraKey: string | undefined
  if (options.jira === false) {
    jiraKey = undefined
  } else if (typeof options.jira === 'string') {
    jiraKey = extractJiraKey(options.jira)
    if (!jiraKey) {
      throw new WtError(`Invalid Jira key: ${options.jira}`, {
        code: 'invalid_jira_key',
        hint: 'Expected a key like ABC-123.',
      })
    }
  } else {
    const fromTitle = extractJiraKey(title)
    jiraKey =
      fromTitle ??
      extractJiraKey(
        (await optionalText(undefined, {
          message: 'Jira key (optional)',
          placeholder: 'ABC-123',
          validate: (value) =>
            extractJiraKey(value) ? undefined : 'Expected a key like ABC-123.',
        })) ?? '',
      )
  }

  const names = generateNames({
    title,
    jiraKey,
    branchPrefix: config.branchPrefix,
  })
  const branch = options.branch ?? names.branch
  const worktreeDir = options.dir ?? names.worktreeDir

  const { base, parent } = await resolveBase(gitDir, {
    base: options.base,
    on: options.on,
    repoPath: repo.path,
  })

  if (!getOutputContext().json) {
    log()
    log(`  ${pc.dim('repo:')}     ${repo.name}`)
    log(`  ${pc.dim('branch:')}   ${pc.cyan(branch)}`)
    log(`  ${pc.dim('worktree:')} ${worktreeDir}`)
    log(`  ${pc.dim('base:')}     ${base}${parent ? pc.yellow(' (stacked)') : ''}`)
    log()
  }

  if (canPrompt() && !options.yes) {
    const proceed = await confirm('Create this worktree?', {
      assumeYes: false,
      defaultValue: true,
    })
    if (!proceed) {
      log('Cancelled.')
      return
    }
  }

  const created = await createWorktree({
    repoPath: repo.path,
    gitDir,
    worktreeDir,
    branch,
    base,
    parentBranch: parent,
    noFetch: !options.fetch,
    noSetup: !options.setup,
  })

  if (getOutputContext().json) {
    emitJson({
      ok: true,
      repo: repo.name,
      path: created.path,
      branch: created.branch,
      base: created.base,
      parent: created.parent ?? null,
    })
    return
  }

  success(`Created ${pc.cyan(branch)} at ${created.path}`)
  emitCd(created.path)
}
