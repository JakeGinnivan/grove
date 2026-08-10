import { Command } from 'commander'
import pc from 'picocolors'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { emitJson, log, success, warn, info, getOutputContext } from '../core/output.js'
import { confirm } from '../core/prompts.js'
import { WtError } from '../core/errors.js'

/** Agent targets we know how to install skills for. */
const TARGETS = {
  claude: join(homedir(), '.claude', 'skills'),
  cursor: join(homedir(), '.cursor', 'skills'),
} as const

type TargetName = keyof typeof TARGETS

export function skillsCommand(): Command {
  const command = new Command('skills').description(
    'Manage agent skills that teach assistants to use wt',
  )

  command
    .command('install', { isDefault: true })
    .description('Install the wt agent skills')
    .option(
      '-t, --target <target>',
      `where to install: ${Object.keys(TARGETS).join(', ')}, or a directory path`,
      'claude',
    )
    .option('-f, --force', 'overwrite existing skills')
    .option('--dry-run', 'show what would be installed')
    .action(async (options) => {
      await runInstall(options)
    })

  command
    .command('list')
    .description('List bundled skills and their install status')
    .option('-t, --target <target>', 'target to check', 'claude')
    .action(async (options) => {
      await runList(options)
    })

  command
    .command('uninstall')
    .description('Remove installed grove skills')
    .option('-t, --target <target>', 'target to remove from', 'claude')
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

function resolveTarget(target: string): string {
  if (target in TARGETS) return TARGETS[target as TargetName]
  // Anything else is treated as an explicit directory.
  return resolve(target)
}

async function listTemplates(): Promise<string[]> {
  const dir = templatesDir()
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

async function runInstall(options: {
  target: string
  force?: boolean
  dryRun?: boolean
}): Promise<void> {
  const source = templatesDir()
  const destRoot = resolveTarget(options.target)
  const names = await listTemplates()

  const planned: { name: string; path: string; action: string }[] = []
  for (const name of names) {
    const dest = join(destRoot, name)
    const exists = existsSync(join(dest, 'SKILL.md'))
    planned.push({
      name,
      path: dest,
      action: !exists ? 'install' : options.force ? 'overwrite' : 'skip',
    })
  }

  if (options.dryRun) {
    if (getOutputContext().json) {
      emitJson({ ok: true, dryRun: true, target: destRoot, skills: planned })
      return
    }
    log()
    log(pc.bold(`Would install to ${destRoot}`))
    for (const item of planned) {
      log(`  ${item.name}  ${pc.dim(item.action)}`)
    }
    log()
    return
  }

  const installed: string[] = []
  const skipped: string[] = []

  for (const item of planned) {
    if (item.action === 'skip') {
      skipped.push(item.name)
      continue
    }
    await mkdir(item.path, { recursive: true })
    const content = await readFile(join(source, item.name, 'SKILL.md'), 'utf8')
    await writeFile(join(item.path, 'SKILL.md'), content, 'utf8')
    installed.push(item.name)
  }

  if (getOutputContext().json) {
    emitJson({ ok: true, target: destRoot, installed, skipped })
    return
  }

  log()
  for (const name of installed) success(`Installed ${pc.cyan(name)} → ${join(destRoot, name)}`)
  for (const name of skipped) {
    warn(`${name} already exists (use --force to overwrite)`)
  }
  if (installed.length > 0) {
    log()
    info('Agents will pick these up on their next session.')
  }
  log()
}

async function runList(options: { target: string }): Promise<void> {
  const destRoot = resolveTarget(options.target)
  const names = await listTemplates()
  const rows = names.map((name) => ({
    name,
    installed: existsSync(join(destRoot, name, 'SKILL.md')),
    path: join(destRoot, name),
  }))

  if (getOutputContext().json) {
    emitJson({ ok: true, target: destRoot, skills: rows })
    return
  }

  log()
  log(pc.bold(`Skills ${pc.dim(`(${destRoot})`)}`))
  for (const row of rows) {
    const status = row.installed ? pc.green('installed') : pc.dim('not installed')
    log(`  ${row.name.padEnd(14)} ${status}`)
  }
  log()
}

async function runUninstall(options: {
  target: string
  yes?: boolean
}): Promise<void> {
  const destRoot = resolveTarget(options.target)
  const names = await listTemplates()
  const present = names.filter((name) =>
    existsSync(join(destRoot, name, 'SKILL.md')),
  )

  if (present.length === 0) {
    if (getOutputContext().json) {
      emitJson({ ok: true, removed: [] })
      return
    }
    log('No grove skills installed.')
    return
  }

  const proceed = await confirm(
    `Remove ${present.length} skill(s) from ${destRoot}?`,
    { assumeYes: options.yes ?? false, defaultValue: false, what: 'Removal' },
  )
  if (!proceed) {
    log('Cancelled.')
    return
  }

  for (const name of present) {
    await rm(join(destRoot, name), { recursive: true, force: true })
  }

  if (getOutputContext().json) {
    emitJson({ ok: true, removed: present })
    return
  }
  success(`Removed ${present.join(', ')}`)
}
