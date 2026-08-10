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

async function listTemplates(): Promise<string[]> {
  const dir = templatesDir()
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

interface InstallReport {
  target: string
  dir: string
  installed: string[]
  skipped: string[]
}

async function runInstall(options: {
  target?: string[]
  force?: boolean
  dryRun?: boolean
}): Promise<void> {
  const source = templatesDir()
  const targets = await chooseTargets(options.target, 'install')
  const names = await listTemplates()

  if (targets.length === 0) {
    log('Nothing selected.')
    return
  }

  const plan = targets.map((target) => ({
    target,
    items: names.map((name) => {
      const dest = join(target.dir, name)
      const exists = existsSync(join(dest, 'SKILL.md'))
      return {
        name,
        path: dest,
        action: !exists ? 'install' : options.force ? 'overwrite' : 'skip',
      }
    }),
  }))

  if (options.dryRun) {
    if (getOutputContext().json) {
      emitJson({
        ok: true,
        dryRun: true,
        targets: plan.map(({ target, items }) => ({
          target: target.name,
          dir: target.dir,
          skills: items,
        })),
      })
      return
    }
    log()
    for (const { target, items } of plan) {
      log(pc.bold(`Would install to ${target.dir}`))
      for (const item of items) log(`  ${item.name}  ${pc.dim(item.action)}`)
      log()
    }
    return
  }

  const reports: InstallReport[] = []
  for (const { target, items } of plan) {
    const report: InstallReport = {
      target: target.name,
      dir: target.dir,
      installed: [],
      skipped: [],
    }
    for (const item of items) {
      if (item.action === 'skip') {
        report.skipped.push(item.name)
        continue
      }
      await mkdir(item.path, { recursive: true })
      const content = await readFile(join(source, item.name, 'SKILL.md'), 'utf8')
      await writeFile(join(item.path, 'SKILL.md'), content, 'utf8')
      report.installed.push(item.name)
    }
    reports.push(report)
  }

  if (getOutputContext().json) {
    emitJson({ ok: true, targets: reports })
    return
  }

  log()
  for (const report of reports) {
    const label = TARGETS[report.target]?.label ?? report.target
    for (const name of report.installed) {
      success(`${pc.cyan(name)} → ${label} ${pc.dim(`(${report.dir})`)}`)
    }
    for (const name of report.skipped) {
      warn(`${name} already installed for ${label} (use --force to overwrite)`)
    }
  }
  if (reports.some((report) => report.installed.length > 0)) {
    log()
    info('Agents will pick these up on their next session.')
  }
  log()
}

async function runList(options: { target?: string[] }): Promise<void> {
  const names = await listTemplates()

  // Listing reports on every tool we know about rather than only the ones
  // installed, so it doubles as a way to see what grove would detect.
  const detected = new Set(detectTargets())
  const targets = options.target?.length
    ? await chooseTargets(options.target, 'list')
    : Object.keys(TARGETS).map(resolveOne)

  const rows = targets.map((target) => ({
    target: target.name,
    dir: target.dir,
    detected: detected.has(target.name),
    skills: names.map((name) => ({
      name,
      installed: existsSync(join(target.dir, name, 'SKILL.md')),
    })),
  }))

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
      const status = skill.installed
        ? pc.green('installed')
        : pc.dim('not installed')
      log(`  ${skill.name.padEnd(14)} ${status}`)
    }
    log()
  }
}

async function runUninstall(options: {
  target?: string[]
  yes?: boolean
}): Promise<void> {
  const names = await listTemplates()

  // Only offer tools that actually have grove skills installed, so the
  // picker never lists somewhere with nothing to remove.
  let targets: ResolvedTarget[]
  if (options.target?.length) {
    targets = await chooseTargets(options.target, 'remove')
  } else {
    const withSkills = Object.keys(TARGETS)
      .map(resolveOne)
      .filter((target) =>
        names.some((name) => existsSync(join(target.dir, name, 'SKILL.md'))),
      )
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

  const removed: { target: string; dir: string; skills: string[] }[] = []
  for (const entry of plan) {
    for (const name of entry.present) {
      await rm(join(entry.target.dir, name), { recursive: true, force: true })
    }
    removed.push({
      target: entry.target.name,
      dir: entry.target.dir,
      skills: entry.present,
    })
  }

  if (getOutputContext().json) {
    emitJson({ ok: true, removed })
    return
  }
  for (const entry of removed) {
    const label = TARGETS[entry.target]?.label ?? entry.target
    success(`Removed ${entry.skills.join(', ')} from ${label}`)
  }
}
