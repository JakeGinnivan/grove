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
import { requireText, canPrompt } from '../core/prompts.js'
import { emitJson, log, success, getOutputContext } from '../core/output.js'
import { resolve } from 'node:path'

export function setupCommand(): Command {
  return new Command('setup')
    .description('Configure grove (branch prefix, clone directory, registry)')
    .option('--branch-prefix <prefix>', 'prefix for generated branch names')
    .option('--code-dir <path>', 'default parent directory for clones')
    .option('--repos-file <path>', 'path to the repo registry file')
    .option('--show', 'print the current configuration and exit')
    .action(async (options) => {
      await runSetup(options)
    })
}

interface SetupOptions {
  branchPrefix?: string
  codeDir?: string
  reposFile?: string
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

  const next: GroveConfig = {
    ...current,
    branchPrefix,
    defaultCodeDir: resolve(expandHome(codeDir)),
    reposFile: resolve(expandHome(reposFile)),
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
  log(pc.cyan('  grove profile add work ~/_code/work --block-push github.com'))
  log()
  log(pc.bold('Install the agent skills:'))
  log(pc.cyan('  grove skills install'))
  log()
}
