import { Command } from 'commander'
import pc from 'picocolors'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { emitJson, log, success, warn, info, getOutputContext } from '../core/output.js'
import { confirm, multiselect, canPrompt } from '../core/prompts.js'
import { WtError } from '../core/errors.js'
import { applyAutoModeHints, type AutoModeHintsResult } from '../core/claude-settings.js'
import {
  hashSkill,
  loadSkillState,
  saveSkillState,
  skillStatus,
  type SkillState,
  type SkillStatus,
} from '../core/skill-state.js'

/**
 * Agent tools we know how to install skills for.
 *
 * Every one of these reads `<dir>/<skill-name>/SKILL.md`, so a skill is
 * installed by copying it into each tool's own directory. There is no shared
 * location that all of them read: `.agents/skills` is understood by some
 * tools but invisible to others, so a copy per tool is what actually works.
 *
 * `marker` is a path whose existence means the tool is installed. It is
 * deliberately not the skills directory itself, which usually does not exist
 * until something creates it.
 */
interface AgentTarget {
  /** Where skills go. */
  dir: string
  /** The tool is installed when any of these paths exists. */
  markers: string[]
  /** Shown in the picker. */
  label: string
}

const home = homedir()

const TARGETS: Record<string, AgentTarget> = {
  claude: {
    dir: join(home, '.claude', 'skills'),
    markers: [join(home, '.claude')],
    label: 'Claude Code',
  },
  codex: {
    dir: join(home, '.codex', 'skills'),
    markers: [join(home, '.codex')],
    label: 'Codex CLI',
  },
  copilot: {
    dir: join(home, '.copilot', 'skills'),
    markers: [join(home, '.copilot')],
    label: 'GitHub Copilot CLI',
  },
  cursor: {
    dir: join(home, '.cursor', 'skills'),
    markers: [join(home, '.cursor')],
    label: 'Cursor',
  },
  gemini: {
    dir: join(home, '.gemini', 'skills'),
    markers: [join(home, '.gemini')],
    label: 'Gemini CLI',
  },
  opencode: {
    // Skills live under the XDG config dir, but the tool may only have
    // created its install dir yet, so either counts as "installed".
    dir: join(home, '.config', 'opencode', 'skills'),
    markers: [join(home, '.config', 'opencode'), join(home, '.opencode')],
    label: 'opencode',
  },
}

/** Known tool names, for help text and shell completions. */
export const TARGET_NAMES = Object.keys(TARGETS)

/** Tool names whose config directory exists on this machine. */
function detectTargets(): string[] {
  return Object.entries(TARGETS)
    .filter(([, target]) => target.markers.some((marker) => existsSync(marker)))
    .map(([name]) => name)
}

export function skillsCommand(): Command {
  const command = new Command('skills').description(
    'Manage agent skills that teach assistants to use wt',
  )

  const targetHelp = `${Object.keys(TARGETS).join(', ')}, "all", or a directory path (default: detected tools)`

  command
    .command('install', { isDefault: true })
    .description('Install the wt agent skills')
    .option('-t, --target <target...>', targetHelp)
    .option('-f, --force', 'overwrite existing skills')
    .option('--dry-run', 'show what would be installed')
    .option('--claude-auto-mode', "add grove's auto mode hints to ~/.claude/settings.json")
    .option('--no-claude-auto-mode', 'do not offer to add auto mode hints')
    .action(async (options) => {
      await runInstall(options)
    })

  command
    .command('list')
    .description('List bundled skills and their install status')
    .option('-t, --target <target...>', targetHelp)
    .action(async (options) => {
      await runList(options)
    })

  command
    .command('uninstall')
    .description('Remove installed grove skills')
    .option('-t, --target <target...>', targetHelp)
    .option('-y, --yes', 'skip confirmation')
    .action(async (options) => {
      await runUninstall(options)
    })

  return command
}

/** Locate the bundled skill templates, in both dev and installed layouts. */
function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'skills'), // bundled: dist/skills
    join(here, '..', 'skills', 'templates'), // dev: src/skills/templates
    join(here, '..', '..', 'src', 'skills', 'templates'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new WtError('Could not locate bundled skill templates.', {
    code: 'skills_missing',
    hint: 'Reinstall the CLI, or run `pnpm build` if working from source.',
  })
}

/** A destination to install into, named for display. */
interface ResolvedTarget {
  name: string
  dir: string
}

function resolveOne(target: string): ResolvedTarget {
  const known = TARGETS[target]
  if (known) return { name: target, dir: known.dir }
  // Anything else is treated as an explicit directory.
  return { name: target, dir: resolve(target) }
}

/**
 * Work out which tools to act on.
 *
 * An explicit --target wins. Otherwise we detect the tools installed on this
 * machine and, when we can prompt, let the user narrow the list down — all
 * pre-selected, so Enter installs everywhere.
 */
async function chooseTargets(
  requested: string[] | undefined,
  action: string,
): Promise<ResolvedTarget[]> {
  if (requested?.length) {
    if (requested.includes('all')) {
      return Object.keys(TARGETS).map(resolveOne)
    }
    return requested.map(resolveOne)
  }

  const detected = detectTargets()
  if (detected.length === 0) {
    throw new WtError('No agent tools detected.', {
      code: 'no_agent_tools',
      hint: `Pass --target with one of: ${Object.keys(TARGETS).join(', ')}, or a directory path.`,
    })
  }

  // A single detected tool needs no prompt.
  if (detected.length === 1 || !canPrompt()) {
    return detected.map(resolveOne)
  }

  const chosen = await multiselect(
    `Which tools should grove ${action} skills for?`,
    detected.map((name) => ({
      value: name,
      label: TARGETS[name]?.label ?? name,
      hint: TARGETS[name]?.dir,
    })),
    'One or more tool names',
    detected,
  )
  return chosen.map(resolveOne)
}

async function listBundledSkillNames(): Promise<string[]> {
  return [...(await bundledSkills()).keys()]
}

/** Bundled skill name to its SKILL.md content. */
async function bundledSkills(): Promise<Map<string, string>> {
  const dir = templatesDir()
  const entries = await readdir(dir, { withFileTypes: true })
  const skills = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    skills.set(entry.name, await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8'))
  }
  return skills
}

interface SkillCheck {
  name: string
  path: string
  status: SkillStatus
}

async function checkTarget(
  target: ResolvedTarget,
  bundled: Map<string, string>,
  state: SkillState,
): Promise<SkillCheck[]> {
  return Promise.all(
    [...bundled].map(async ([name, content]) => {
      const file = join(target.dir, name, 'SKILL.md')
      const installed = existsSync(file) ? await readFile(file, 'utf8') : undefined
      return {
        name,
        path: join(target.dir, name),
        status: skillStatus(installed, content, state.installed[file]?.hash),
      }
    }),
  )
}

type SkillAction = 'install' | 'update' | 'current' | 'overwrite' | 'skip'

function actionFor(status: SkillStatus, force: boolean): SkillAction {
  switch (status) {
    case 'missing':
      return 'install'
    case 'outdated':
      return 'update'
    case 'current':
      return 'current'
    case 'modified':
      return force ? 'overwrite' : 'skip'
  }
}

/** Known tools that already have at least one grove skill installed. */
function targetsWithSkills(names: string[]): ResolvedTarget[] {
  return Object.keys(TARGETS)
    .map(resolveOne)
    .filter((target) => names.some((name) => existsSync(join(target.dir, name, 'SKILL.md'))))
}

/**
 * Labels of tools whose grove skills an update would change: one is older
 * than this grove's, or this grove ships a skill the tool doesn't have yet.
 * Skills the user edited don't count, since an update leaves them alone.
 */
export async function outdatedSkillTargets(): Promise<string[]> {
  const bundled = await bundledSkills()
  const state = await loadSkillState()
  const labels: string[] = []
  for (const target of targetsWithSkills([...bundled.keys()])) {
    const checks = await checkTarget(target, bundled, state)
    if (checks.some((check) => check.status === 'outdated' || check.status === 'missing')) {
      labels.push(TARGETS[target.name]?.label ?? target.name)
    }
  }
  return labels
}

interface InstallReport {
  target: string
  dir: string
  /** Newly installed. */
  installed: string[]
  /** Replaced with this grove's version: outdated, or edited and forced. */
  updated: string[]
  /** Already the same as this grove's version. */
  current: string[]
  /** Edited locally, so left alone without --force. */
  skipped: string[]
}

/**
 * Bring each target's skills to this grove's versions, and record what was
 * written so a later run can tell an outdated skill from an edited one.
 */
async function installSkills(
  targets: ResolvedTarget[],
  options: { force?: boolean } = {},
): Promise<InstallReport[]> {
  const bundled = await bundledSkills()
  const state = await loadSkillState()
  const reports: InstallReport[] = []
  for (const target of targets) {
    const report: InstallReport = {
      target: target.name,
      dir: target.dir,
      installed: [],
      updated: [],
      current: [],
      skipped: [],
    }
    for (const check of await checkTarget(target, bundled, state)) {
      const content = bundled.get(check.name)!
      const file = join(check.path, 'SKILL.md')
      const action = actionFor(check.status, options.force ?? false)
      if (action === 'skip') {
        report.skipped.push(check.name)
        continue
      }
      if (action === 'current') {
        report.current.push(check.name)
      } else {
        await mkdir(check.path, { recursive: true })
        await writeFile(file, content, 'utf8')
        ;(action === 'install' ? report.installed : report.updated).push(check.name)
      }
      state.installed[file] = { hash: hashSkill(content) }
    }
    reports.push(report)
  }
  await saveSkillState(state)
  return reports
}

function reportInstall(reports: InstallReport[]): void {
  for (const report of reports) {
    const label = TARGETS[report.target]?.label ?? report.target
    for (const name of report.installed) {
      success(`${pc.cyan(name)} → ${label} ${pc.dim(`(${report.dir})`)}`)
    }
    for (const name of report.updated) {
      success(`Updated ${pc.cyan(name)} for ${label}`)
    }
    if (report.current.length > 0) {
      info(`${label}: ${report.current.join(', ')} already up to date`)
    }
    for (const name of report.skipped) {
      warn(`${name} for ${label} has local changes, so it was left as is (use --force to replace it)`)
    }
  }
}

async function runInstall(options: {
  target?: string[]
  force?: boolean
  dryRun?: boolean
  claudeAutoMode?: boolean
}): Promise<void> {
  // Once grove's skills are installed somewhere, re-running install means
  // "bring them up to date": no picker, no auto mode question, the same tools.
  const existing = options.target?.length ? [] : targetsWithSkills(await listBundledSkillNames())
  const updating = existing.length > 0
  const targets = updating ? existing : await chooseTargets(options.target, 'install')
  const elsewhere = updating
    ? detectTargets().filter((name) => !existing.some((target) => target.name === name))
    : []

  if (targets.length === 0) {
    log('Nothing selected.')
    return
  }

  if (options.dryRun) {
    const bundled = await bundledSkills()
    const state = await loadSkillState()
    const plan = await Promise.all(
      targets.map(async (target) => ({
        target,
        items: (await checkTarget(target, bundled, state)).map((check) => ({
          name: check.name,
          path: check.path,
          status: check.status,
          action: actionFor(check.status, options.force ?? false),
        })),
      })),
    )
    const autoMode = wantsClaude(targets) && options.claudeAutoMode !== false
      ? await applyAutoModeHints({ dryRun: true })
      : null
    if (getOutputContext().json) {
      emitJson({
        ok: true,
        dryRun: true,
        targets: plan.map(({ target, items }) => ({
          target: target.name,
          dir: target.dir,
          skills: items,
        })),
        claudeAutoMode: autoMode,
      })
      return
    }
    log()
    for (const { target, items } of plan) {
      log(pc.bold(`Would install to ${target.dir}`))
      for (const item of items) log(`  ${item.name}  ${pc.dim(item.action)}`)
      log()
    }
    if (autoMode) {
      log(pc.bold('Claude Code auto mode hints'))
      log(`  ${autoMode.path}  ${pc.dim(autoMode.status === 'present' ? 'already present' : autoMode.status)}`)
      log()
    }
    return
  }

  const reports = await installSkills(targets, { force: options.force })

  const autoMode =
    wantsClaude(targets) && !(updating && options.claudeAutoMode === undefined)
      ? await installAutoModeHints(options.claudeAutoMode)
      : null

  if (getOutputContext().json) {
    emitJson({ ok: true, targets: reports, notInstalled: elsewhere, claudeAutoMode: autoMode })
    return
  }

  log()
  reportInstall(reports)
  if (elsewhere.length > 0) {
    const labels = elsewhere.map((name) => TARGETS[name]?.label ?? name).join(', ')
    info(`Also detected ${labels}. Add the skills there with \`grove skills install --target ${elsewhere.join(' ')}\`.`)
  }
  if (autoMode) reportAutoMode(autoMode)
  if (reports.some((report) => report.installed.length + report.updated.length > 0)) {
    log()
    info('Agents will pick these up on their next session.')
  }
  log()
}

function wantsClaude(targets: ResolvedTarget[]): boolean {
  return targets.some((target) => target.name === 'claude')
}

type AutoModeOutcome = AutoModeHintsResult | { status: 'declined' | 'not-requested' }

/**
 * Offer to teach Claude Code's auto mode classifier about grove. This edits
 * the user's own Claude settings, so it is opt-in: an explicit flag, or a yes
 * at the prompt. A non-interactive run without the flag changes nothing.
 */
async function installAutoModeHints(requested: boolean | undefined): Promise<AutoModeOutcome> {
  if (requested === false) return { status: 'declined' }
  if (requested === true) return applyAutoModeHints()

  const preview = await applyAutoModeHints({ dryRun: true })
  if (preview.status === 'present' || preview.status === 'invalid') return preview
  if (!canPrompt() || getOutputContext().json) return { status: 'not-requested' }

  log()
  const proceed = await confirm(
    `Add grove's auto mode hints to ${preview.path}? They tell Claude Code's auto mode that grove cleanup without --force is safe.`,
    { assumeYes: false, defaultValue: true, what: 'Adding auto mode hints' },
  )
  return proceed ? applyAutoModeHints() : { status: 'declined' }
}

function reportAutoMode(outcome: AutoModeOutcome): void {
  switch (outcome.status) {
    case 'added':
    case 'updated':
      success(`Auto mode hints ${outcome.status} in ${outcome.path}`)
      info('Check with `claude auto-mode config`.')
      break
    case 'invalid':
      warn(`Left ${outcome.path} unchanged: ${outcome.reason}`)
      break
    case 'not-requested':
      info('Pass --claude-auto-mode to add grove hints to Claude Code auto mode.')
      break
    default:
      break
  }
}

async function runList(options: { target?: string[] }): Promise<void> {
  const bundled = await bundledSkills()
  const state = await loadSkillState()

  // Listing reports on every tool we know about rather than only the ones
  // installed, so it doubles as a way to see what grove would detect.
  const detected = new Set(detectTargets())
  const targets = options.target?.length
    ? await chooseTargets(options.target, 'list')
    : Object.keys(TARGETS).map(resolveOne)

  const rows = await Promise.all(
    targets.map(async (target) => ({
      target: target.name,
      dir: target.dir,
      detected: detected.has(target.name),
      skills: (await checkTarget(target, bundled, state)).map((check) => ({
        name: check.name,
        installed: check.status !== 'missing',
        status: check.status,
      })),
    })),
  )

  if (getOutputContext().json) {
    emitJson({ ok: true, targets: rows })
    return
  }

  log()
  for (const row of rows) {
    const label = TARGETS[row.target]?.label ?? row.target
    const presence = row.detected ? '' : pc.dim(' (not detected)')
    log(`${pc.bold(label)}${presence}  ${pc.dim(row.dir)}`)
    for (const skill of row.skills) {
      const status = STATUS_LABELS[skill.status]
      log(`  ${skill.name.padEnd(14)} ${status}`)
    }
    log()
  }
}

const STATUS_LABELS: Record<SkillStatus, string> = {
  missing: pc.dim('not installed'),
  current: pc.green('up to date'),
  outdated: pc.yellow('outdated, run `grove skills install`'),
  modified: pc.yellow('edited locally'),
}

async function runUninstall(options: {
  target?: string[]
  yes?: boolean
}): Promise<void> {
  const names = await listBundledSkillNames()

  // Only offer tools that actually have grove skills installed, so the
  // picker never lists somewhere with nothing to remove.
  let targets: ResolvedTarget[]
  if (options.target?.length) {
    targets = await chooseTargets(options.target, 'remove')
  } else {
    const withSkills = targetsWithSkills(names)
    if (withSkills.length > 1 && canPrompt()) {
      const chosen = await multiselect(
        'Which tools should grove remove skills from?',
        withSkills.map((target) => ({
          value: target.name,
          label: TARGETS[target.name]?.label ?? target.name,
          hint: target.dir,
        })),
        'One or more tool names',
        withSkills.map((target) => target.name),
      )
      targets = chosen.map(resolveOne)
    } else {
      targets = withSkills
    }
  }

  const plan = targets
    .map((target) => ({
      target,
      present: names.filter((name) =>
        existsSync(join(target.dir, name, 'SKILL.md')),
      ),
    }))
    .filter((entry) => entry.present.length > 0)

  if (plan.length === 0) {
    if (getOutputContext().json) {
      emitJson({ ok: true, removed: [] })
      return
    }
    log('No grove skills installed.')
    return
  }

  const total = plan.reduce((sum, entry) => sum + entry.present.length, 0)
  const where = plan.map((entry) => entry.target.dir).join(', ')
  const proceed = await confirm(`Remove ${total} skill(s) from ${where}?`, {
    assumeYes: options.yes ?? false,
    defaultValue: false,
    what: 'Removal',
  })
  if (!proceed) {
    log('Cancelled.')
    return
  }

  const state = await loadSkillState()
  const removed: { target: string; dir: string; skills: string[] }[] = []
  for (const entry of plan) {
    for (const name of entry.present) {
      await rm(join(entry.target.dir, name), { recursive: true, force: true })
      delete state.installed[join(entry.target.dir, name, 'SKILL.md')]
    }
    removed.push({
      target: entry.target.name,
      dir: entry.target.dir,
      skills: entry.present,
    })
  }

  await saveSkillState(state)

  if (getOutputContext().json) {
    emitJson({ ok: true, removed })
    return
  }
  for (const entry of removed) {
    const label = TARGETS[entry.target]?.label ?? entry.target
    success(`Removed ${entry.skills.join(', ')} from ${label}`)
  }
}
