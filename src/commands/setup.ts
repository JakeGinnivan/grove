import { Command } from 'commander'
import pc from 'picocolors'
import {
  loadConfig,
  saveConfig,
  profileList,
  expandHome,
  CONFIG_PATH,
  type GroveConfig,
} from '../core/config.js'
import { requireText, canPrompt, multiselect } from '../core/prompts.js'
import {
  TASK_TRACKERS,
  TASK_TRACKER_IDS,
  parseTrackerList,
  type TaskTrackerId,
} from '../core/trackers.js'
import { WtError } from '../core/errors.js'
import { emitJson, log, success, getOutputContext } from '../core/output.js'
import { resolve } from 'node:path'

export function setupCommand(): Command {
  return new Command('setup')
    .description('Configure grove (branch prefix, clone directory, registry, task trackers)')
    .option('--branch-prefix <prefix>', 'prefix for generated branch names')
    .option('--code-dir <path>', 'default parent directory for clones')
    .option('--repos-file <path>', 'path to the repo registry file')
    .option(
      '--task-trackers <list>',
      `comma-separated trackers to detect issue keys for (${TASK_TRACKER_IDS.join(', ')}), or none`,
    )
    .option('--show', 'print the current configuration and exit')
    .action(async (options) => {
      await runSetup(options)
    })
}

interface SetupOptions {
  branchPrefix?: string
  codeDir?: string
  reposFile?: string
  taskTrackers?: string
  show?: boolean
}

async function runSetup(options: SetupOptions): Promise<void> {
  const current = await loadConfig()

  if (options.show) {
    if (getOutputContext().json) {
      emitJson({ ok: true, configPath: CONFIG_PATH, config: current })
      return
    }
    log()
    log(pc.bold(`Configuration ${pc.dim(`(${CONFIG_PATH})`)}`))
    log(`  branchPrefix    ${current.branchPrefix}`)
    log(`  defaultCodeDir  ${current.defaultCodeDir}`)
    log(`  reposFile       ${current.reposFile}`)
    log(`  useTrash        ${current.useTrash}`)
    log(`  taskTrackers    ${current.taskTrackers.join(', ') || 'none'}`)
    const profiles = profileList(current)
    if (profiles.length > 0) {
      log()
      log(pc.bold('  Profiles'))
      for (const profile of profiles) {
        const marker = current.defaultProfile === profile.name ? ' (default)' : ''
        log(`    ${profile.name}${marker} → ${profile.dir}`)
      }
    }
    log()
    return
  }

  const interactive = canPrompt()

  const branchPrefix = await requireText(
    options.branchPrefix ?? (interactive ? undefined : current.branchPrefix),
    {
      message: 'Branch prefix for generated branches',
      flag: '--branch-prefix',
      what: 'A branch prefix',
      initialValue: current.branchPrefix,
    },
  )

  const codeDir = await requireText(
    options.codeDir ?? (interactive ? undefined : current.defaultCodeDir),
    {
      message: 'Default directory for clones (used when no profile matches)',
      flag: '--code-dir',
      what: 'A clone directory',
      initialValue: current.defaultCodeDir,
    },
  )

  const reposFile = await requireText(
    options.reposFile ?? (interactive ? undefined : current.reposFile),
    {
      message: 'Repo registry file',
      flag: '--repos-file',
      what: 'A registry file path',
      initialValue: current.reposFile,
    },
  )

  let taskTrackers: TaskTrackerId[]
  if (options.taskTrackers !== undefined) {
    const parsed = parseTrackerList(options.taskTrackers)
    if (typeof parsed === 'string') {
      throw new WtError(parsed, { code: 'invalid_task_tracker' })
    }
    taskTrackers = parsed
  } else if (interactive) {
    const chosen = await multiselect(
      'Task trackers for issue keys (none to skip the prompt in grove new)',
      TASK_TRACKER_IDS.map((id) => ({
        value: id,
        label: TASK_TRACKERS[id].label,
        hint: TASK_TRACKERS[id].example,
      })),
      'Task trackers',
      current.taskTrackers,
    )
    // Keep the configured detection order for trackers that stay enabled.
    taskTrackers = [
      ...current.taskTrackers.filter((id) => chosen.includes(id)),
      ...TASK_TRACKER_IDS.filter((id) => chosen.includes(id) && !current.taskTrackers.includes(id)),
    ]
  } else {
    taskTrackers = current.taskTrackers
  }

  const next: GroveConfig = {
    ...current,
    branchPrefix,
    defaultCodeDir: resolve(expandHome(codeDir)),
    reposFile: resolve(expandHome(reposFile)),
    taskTrackers,
  }

  await saveConfig(next)

  if (getOutputContext().json) {
    emitJson({ ok: true, configPath: CONFIG_PATH, config: next })
    return
  }

  log()
  success(`Wrote ${CONFIG_PATH}`)
  log()
  log(pc.bold('Add shell integration for the `wt` shortcut and completions:'))
  log()
  log(pc.cyan('  # ~/.zshrc'))
  log(pc.cyan('  eval "$(grove shell-init zsh)"'))
  log()
  log(pc.bold('Optional — group repos into profiles with their own rules:'))
  log(pc.cyan('  grove profile add work ~/_code/work --default'))
  log()
  log(pc.bold('Install the agent skills:'))
  log(pc.cyan('  grove skills install'))
  log()
}
