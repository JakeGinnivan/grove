import { Command } from 'commander'
import pc from 'picocolors'
import { existsSync } from 'node:fs'
import {
  loadConfig,
  saveConfig,
  profileList,
  expandHome,
  tildify,
  CONFIG_PATH,
  type GroveConfig,
} from '../core/config.js'
import {
  requireText,
  optionalText,
  canPrompt,
  confirm,
  select,
  multiselect,
  intro,
  outro,
} from '../core/prompts.js'
import {
  TASK_TRACKERS,
  TASK_TRACKER_IDS,
  parseTrackerList,
  type TaskTrackerId,
} from '../core/trackers.js'
import { CancelledError, WtError } from '../core/errors.js'
import { emitJson, log, success, getOutputContext } from '../core/output.js'
import {
  detectShell,
  installShellIntegration,
  shellIntegrationStatus,
  type ShellIntegrationStatus,
} from '../core/shell-rc.js'
import { resolve } from 'node:path'

export function setupCommand(): Command {
  return new Command('setup')
    .description(
      'Configure grove: an interactive settings menu, or set values with the flags below',
    )
    .option('--branch-prefix <prefix>', 'prefix for generated branch names')
    .option('--code-dir <path>', 'default parent directory for clones')
    .option('--repos-file <path>', 'path to the repo registry file')
    .option(
      '--task-trackers <list>',
      `comma-separated trackers to detect issue keys for (${TASK_TRACKER_IDS.join(', ')}), or none`,
    )
    .option('--trash', 'move removed worktrees to the trash')
    .option('--no-trash', 'delete removed worktrees outright')
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
  trash?: boolean
  show?: boolean
}

async function runSetup(options: SetupOptions): Promise<void> {
  if (options.show) {
    showConfig(await loadConfig())
    return
  }

  const current = await loadConfig({ env: false })

  const firstRun = !existsSync(CONFIG_PATH)
  const hasFlags =
    options.branchPrefix !== undefined ||
    options.codeDir !== undefined ||
    options.reposFile !== undefined ||
    options.taskTrackers !== undefined ||
    options.trash !== undefined

  // Flags set exactly what they name and nothing else, so scripts and agents
  // never meet a prompt. Without flags, a terminal gets the menu; anything
  // else writes the current (or default) config as-is.
  let next: GroveConfig
  let installShell = false
  if (hasFlags) {
    next = applyFlags(current, options)
  } else if (canPrompt()) {
    const edited = await settingsMenu(current, await shellIntegrationStatus(detectShell()))
    if (!edited) return
    next = edited.config
    installShell = edited.installShell
  } else {
    next = current
  }

  if (installShell) {
    const result = await installShellIntegration(detectShell(), { name: 'wt', completions: true })
    success(`Added shell integration to ${tildify(result.rcFile)}`)
    log(`  Open a new terminal, or run: source ${tildify(result.rcFile)}`)
  }

  if (!firstRun && sameSettings(current, next)) {
    if (getOutputContext().json) {
      emitJson({ ok: true, configPath: CONFIG_PATH, config: next, changed: false })
    } else if (!installShell) {
      log('No changes.')
    }
    return
  }

  await saveConfig(next)

  if (getOutputContext().json) {
    emitJson({ ok: true, configPath: CONFIG_PATH, config: next, changed: true })
    return
  }

  success(`Wrote ${CONFIG_PATH}`)
  if (firstRun) printNextSteps(await shellIntegrationStatus(detectShell()))
}

function showConfig(config: GroveConfig): void {
  if (getOutputContext().json) {
    emitJson({ ok: true, configPath: CONFIG_PATH, config })
    return
  }
  log()
  log(pc.bold(`Configuration ${pc.dim(`(${CONFIG_PATH})`)}`))
  log(`  branchPrefix    ${config.branchPrefix}`)
  log(`  defaultCodeDir  ${config.defaultCodeDir}`)
  log(`  reposFile       ${config.reposFile}`)
  log(`  useTrash        ${config.useTrash}`)
  log(`  taskTrackers    ${config.taskTrackers.join(', ') || 'none'}`)
  const profiles = profileList(config)
  if (profiles.length > 0) {
    log()
    log(pc.bold('  Profiles'))
    for (const profile of profiles) {
      const marker = config.defaultProfile === profile.name ? ' (default)' : ''
      log(`    ${profile.name}${marker} → ${profile.dir}`)
    }
  }
  log()
}

function applyFlags(current: GroveConfig, options: SetupOptions): GroveConfig {
  const next: GroveConfig = { ...current }
  if (options.branchPrefix !== undefined) next.branchPrefix = options.branchPrefix
  if (options.codeDir !== undefined) next.defaultCodeDir = resolvePath(options.codeDir)
  if (options.reposFile !== undefined) next.reposFile = resolvePath(options.reposFile)
  if (options.trash !== undefined) next.useTrash = options.trash
  if (options.taskTrackers !== undefined) {
    const parsed = parseTrackerList(options.taskTrackers)
    if (typeof parsed === 'string') {
      throw new WtError(parsed, { code: 'invalid_task_tracker' })
    }
    next.taskTrackers = parsed
  }
  return next
}

function resolvePath(path: string): string {
  return resolve(expandHome(path))
}

type SettingKey =
  | 'branchPrefix'
  | 'defaultCodeDir'
  | 'reposFile'
  | 'taskTrackers'
  | 'useTrash'
  | 'defaultProfile'

const SETTING_LABELS: Record<SettingKey, string> = {
  branchPrefix: 'Branch prefix',
  defaultCodeDir: 'Clone directory',
  reposFile: 'Repo registry',
  taskTrackers: 'Task trackers',
  useTrash: 'Use trash',
  defaultProfile: 'Default profile',
}

function settingValue(config: GroveConfig, key: SettingKey): string {
  switch (key) {
    case 'branchPrefix':
      return config.branchPrefix === '' ? '(none)' : config.branchPrefix
    case 'defaultCodeDir':
      return tildify(config.defaultCodeDir)
    case 'reposFile':
      return tildify(config.reposFile)
    case 'taskTrackers':
      return config.taskTrackers.map((id) => TASK_TRACKERS[id].label).join(', ') || 'none'
    case 'useTrash':
      return config.useTrash ? 'yes' : 'no, delete outright'
    case 'defaultProfile':
      return config.defaultProfile ?? 'none'
  }
}

function sameSettings(a: GroveConfig, b: GroveConfig): boolean {
  const keys = Object.keys(SETTING_LABELS) as SettingKey[]
  return keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]))
}

const DONE = '__done__'
const SHELL = '__shell__'
const SHELL_LABEL = 'Shell integration'

/**
 * A menu of every setting with its current value. Picking one edits just
 * that setting and returns to the menu; Done saves. Returns undefined when
 * the user backs out of the menu itself, which discards the edits.
 *
 * Shell integration is not a config value, but it belongs in first-time
 * setup. Like the settings it is only written on save.
 */
async function settingsMenu(
  current: GroveConfig,
  shell: ShellIntegrationStatus,
): Promise<{ config: GroveConfig; installShell: boolean } | undefined> {
  intro('Grove settings')
  let draft: GroveConfig = { ...current }
  let installShell = false
  let cursor: string | undefined

  const keys: SettingKey[] = [
    'branchPrefix',
    'defaultCodeDir',
    'reposFile',
    'taskTrackers',
    'useTrash',
  ]
  // Profiles are added with `grove profile add`; only offer a default once
  // there is something to choose.
  if (profileList(current).length > 0) keys.push('defaultProfile')
  const width =
    Math.max(SHELL_LABEL.length, ...keys.map((key) => SETTING_LABELS[key].length)) + 2
  const shellValue = () =>
    shell.installedIn
      ? `installed in ${tildify(shell.installedIn)}`
      : installShell
        ? `will add to ${tildify(shell.rcFile)}`
        : 'not installed'

  for (;;) {
    const changed = !sameSettings(current, draft) || installShell
    let choice: string
    try {
      choice = await select(
        `Choose a setting to change ${pc.dim(`(${tildify(CONFIG_PATH)})`)}`,
        [
          ...keys.map((key) => ({
            value: key,
            label: `${SETTING_LABELS[key].padEnd(width)}${pc.dim(settingValue(draft, key))}`,
          })),
          { value: SHELL, label: `${SHELL_LABEL.padEnd(width)}${pc.dim(shellValue())}` },
          { value: DONE, label: changed ? 'Save and exit' : 'Done' },
        ],
        'A setting',
        cursor,
      )
    } catch (error) {
      if (!(error instanceof CancelledError)) throw error
      outro(changed ? 'Discarded changes.' : 'No changes.')
      return undefined
    }

    if (choice === DONE) {
      outro(changed ? 'Saving.' : 'No changes.')
      return { config: draft, installShell }
    }

    cursor = choice
    try {
      if (choice === SHELL) {
        if (shell.installedIn) continue
        installShell = await confirm(
          `Add the \`wt\` command and completions to ${tildify(shell.rcFile)}?`,
          { assumeYes: false, defaultValue: true },
        )
        continue
      }
      draft = await editSetting(choice as SettingKey, draft)
    } catch (error) {
      // Escape in a single setting goes back to the menu, not out of setup.
      if (!(error instanceof CancelledError)) throw error
    }
  }
}

async function editSetting(key: SettingKey, draft: GroveConfig): Promise<GroveConfig> {
  switch (key) {
    case 'branchPrefix': {
      // Empty is allowed: branches are then named after the title alone.
      const value = await optionalText(undefined, {
        message: 'Branch prefix for generated branches (empty for none)',
        initialValue: draft.branchPrefix,
      })
      return { ...draft, branchPrefix: value ?? '' }
    }
    case 'defaultCodeDir': {
      const value = await requireText(undefined, {
        message: 'Default directory for clones (used when no profile matches)',
        flag: '--code-dir',
        what: 'A clone directory',
        initialValue: tildify(draft.defaultCodeDir),
      })
      return { ...draft, defaultCodeDir: resolvePath(value) }
    }
    case 'reposFile': {
      const value = await requireText(undefined, {
        message: 'Repo registry file',
        flag: '--repos-file',
        what: 'A registry file path',
        initialValue: tildify(draft.reposFile),
      })
      return { ...draft, reposFile: resolvePath(value) }
    }
    case 'taskTrackers': {
      const chosen = await multiselect(
        'Task trackers for issue keys (select none to skip the prompt in grove new)',
        TASK_TRACKER_IDS.map((id) => ({
          value: id,
          label: TASK_TRACKERS[id].label,
          hint: TASK_TRACKERS[id].example,
        })),
        'Task trackers',
        draft.taskTrackers,
      )
      // Keep the configured detection order for trackers that stay enabled.
      const taskTrackers: TaskTrackerId[] = [
        ...draft.taskTrackers.filter((id) => chosen.includes(id)),
        ...TASK_TRACKER_IDS.filter(
          (id) => chosen.includes(id) && !draft.taskTrackers.includes(id),
        ),
      ]
      return { ...draft, taskTrackers }
    }
    case 'useTrash': {
      const useTrash = await confirm('Move removed worktrees to the trash?', {
        assumeYes: false,
        defaultValue: draft.useTrash,
      })
      return { ...draft, useTrash }
    }
    case 'defaultProfile': {
      const NONE = '__none__'
      const choice = await select(
        'Profile used when --profile is not given',
        [
          ...profileList(draft).map((profile) => ({
            value: profile.name,
            label: profile.name,
            hint: tildify(profile.dir),
          })),
          { value: NONE, label: 'none', hint: 'use the clone directory' },
        ],
        'A profile',
        draft.defaultProfile ?? NONE,
      )
      const next = { ...draft }
      if (choice === NONE) delete next.defaultProfile
      else next.defaultProfile = choice
      return next
    }
  }
}

function printNextSteps(shell: ShellIntegrationStatus): void {
  log()
  if (!shell.installedIn) {
    log(pc.bold('Add shell integration for the `wt` shortcut and completions:'))
    log(pc.cyan('  grove shell-init --install'))
    log()
  }
  log(pc.bold('Optional — group repos into profiles with their own rules:'))
  log(pc.cyan('  grove profile add work ~/_code/work --default'))
  log()
  log(pc.bold('Install the agent skills:'))
  log(pc.cyan('  grove skills install'))
  log()
}
