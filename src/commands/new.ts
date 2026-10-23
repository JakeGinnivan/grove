import { Command } from 'commander'
import { loadConfig } from '../core/config.js'
import { resolveRepo, gitDirFor } from '../core/registry.js'
import { generateNames } from '../core/naming.js'
import {
  TASK_TRACKERS,
  TASK_TRACKER_IDS,
  enabledTrackers,
  findIssue,
  parseIssue,
  describeFormats,
  type Issue,
} from '../core/trackers.js'
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
    .option('-i, --issue <key>', 'issue key, matched against the configured task trackers')
    .option('--no-issue', 'skip the issue prompt entirely')
    .option('-j, --jira <key>', 'Jira issue key, e.g. ABC-123')
    .option('--no-jira', 'same as --no-issue')
    .option(
      '--on <branch|worktree>',
      'stack on an existing branch or worktree instead of the default base',
    )
    .option('--base <ref>', 'explicit base ref (default: origin/HEAD)')
    .option('-b, --branch <name>', 'override the generated branch name')
    .option('-d, --dir <name>', 'override the generated worktree directory name')
    .option('--no-fetch', 'skip fetching origin first')
    .option('--setup', 'run trusted repo-defined worktree setup commands', false)
    .option('--no-setup', 'skip repo-defined worktree setup commands')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async (repoArg, titleArg, options) => {
      await runNew(repoArg, titleArg, options)
    })
}

interface NewOptions {
  title?: string
  issue?: string | false
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

  const issue = await resolveIssue(title, options, config.taskTrackers)

  const names = generateNames({
    title,
    issueKey: issue?.key,
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
    setup: options.setup,
  })

  if (getOutputContext().json) {
    emitJson({
      ok: true,
      repo: repo.name,
      path: created.path,
      branch: created.branch,
      base: created.base,
      parent: created.parent ?? null,
      issue: issue ?? null,
      port: created.port,
      portWarning: created.portWarning,
    })
    return
  }

  success(`Created ${pc.cyan(branch)} at ${created.path}`)
  emitCd(created.path)
}

/**
 * --no-issue disables the prompt; an explicit key wins; otherwise we look for
 * a key from an enabled tracker in the title before asking. With no trackers
 * enabled there is nothing to detect and no prompt.
 */
async function resolveIssue(
  title: string,
  options: NewOptions,
  taskTrackers: readonly string[],
): Promise<Issue | undefined> {
  if (options.issue === false || options.jira === false) return undefined

  if (typeof options.jira === 'string') {
    const key = TASK_TRACKERS.jira.parse(options.jira)
    if (!key) {
      throw new WtError(`Invalid Jira key: ${options.jira}`, {
        code: 'invalid_jira_key',
        hint: 'Expected a key like ABC-123.',
      })
    }
    return { tracker: 'jira', key }
  }

  const enabled = enabledTrackers(taskTrackers)

  if (typeof options.issue === 'string') {
    // An explicit key is accepted from any tracker; enabled ones go first so
    // they win when two trackers share a key shape.
    const all = [...enabled, ...enabledTrackers(TASK_TRACKER_IDS)]
    const issue = parseIssue(options.issue, all)
    if (!issue) {
      throw new WtError(`Invalid issue key: ${options.issue}`, {
        code: 'invalid_issue_key',
        hint: `Expected a key like ${describeFormats(all)}.`,
      })
    }
    return issue
  }

  if (enabled.length === 0) return undefined

  const fromTitle = findIssue(title, enabled)
  if (fromTitle) return fromTitle

  const formats = describeFormats(enabled)
  const typed = await optionalText(undefined, {
    message:
      enabled.length === 1 ? `${enabled[0]!.label} key (optional)` : 'Issue key (optional)',
    placeholder: formats,
    validate: (value) =>
      parseIssue(value, enabled) ? undefined : `Expected a key like ${formats}.`,
  })
  return typed ? parseIssue(typed, enabled) : undefined
}
