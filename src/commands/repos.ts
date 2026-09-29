import { Command } from 'commander'
import pc from 'picocolors'
import { existsSync } from 'node:fs'
import { loadConfig } from '../core/config.js'
import { readRegistry, gitDirFor, writeRepo, removeRepo } from '../core/registry.js'
import { emitJson, log, success, warn, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'
import { runImport } from './import.js'

export function reposCommand(): Command {
  const command = new Command('repos')
    .description('List registered repos and their paths')
    .action(async () => {
      await runRepos()
    })

  // Replaced by `grove import`, which does the same registration and can also
  // fix a layout that is not <repo>/main. Kept as a forwarding shim so the old
  // invocation keeps working; slated for removal in v1.
  command
    .command('add', { hidden: true })
    .description('Deprecated: use `grove import` instead')
    .argument('<path>', 'path to the repo or its worktree parent directory')
    .option('-n, --name <name>', 'name to register (default: directory name)')
    .option('-a, --alias <alias>', 'short alias')
    .option('--base-port <port>', 'local start port for this repo')
    .action(async (path, options) => {
      warn('`grove repos add` is deprecated and will be removed in v1.')
      log(
        pc.dim(
          `  Use \`grove import ${path}\` instead${options.name ? ` (name: \`grove import ${path} ${options.name}\`)` : ''}.`,
        ),
      )
      // --no-restructure preserves what `repos add` did: register the repo
      // exactly as it is. Anyone wanting the layout fixed should call import.
      await runImport(path, options.name, {
        restructure: false,
        deprecationNotice:
          '`grove repos add` is deprecated and will be removed in v1; use `grove import`.',
        ...(options.basePort ? { basePort: options.basePort } : {}),
        ...(options.alias === undefined ? { alias: false } : { alias: options.alias }),
      })
    })

  command
    .command('remove')
    .alias('rm')
    .description('Unregister a repo (does not delete files)')
    .argument('<name>', 'registered repo name')
    .action(async (name) => {
      await runRemove(name)
    })

  return command
}

/** Shape returned by `wt repos --json`; consumed by the agent skills. */
export interface RepoReport {
  name: string
  aliasOf: string | null
  path: string
  mainPath: string | null
  exists: boolean
}

export async function buildRepoReports(
  reposFile: string,
): Promise<RepoReport[]> {
  const entries = await readRegistry(reposFile)
  return Promise.all(
    entries.map(async (entry): Promise<RepoReport> => {
      let mainPath: string | null = null
      try {
        mainPath = await gitDirFor(entry.path)
      } catch {
        mainPath = null
      }
      return {
        name: entry.name,
        aliasOf: entry.aliasOf ?? null,
        path: entry.path,
        mainPath,
        exists: existsSync(entry.path),
      }
    }),
  )
}

async function runRepos(): Promise<void> {
  const config = await loadConfig()
  const reports = await buildRepoReports(config.reposFile)

  if (getOutputContext().json) {
    emitJson({ ok: true, registryFile: config.reposFile, repos: reports })
    return
  }

  if (reports.length === 0) {
    log('No repos registered yet.')
    log(pc.dim('  Use `wt clone <url>` or `wt import <path>`.'))
    return
  }

  log()
  log(pc.bold(`Registered repos ${pc.dim(`(${config.reposFile})`)}`))
  const width = Math.max(...reports.map((r) => r.name.length))
  for (const report of reports) {
    const name = report.name.padEnd(width)
    if (report.aliasOf) {
      log(`  ${name}  ${pc.dim(`alias for ${report.aliasOf}`)}`)
    } else {
      const missing = report.exists ? '' : pc.red('  (missing)')
      log(`  ${name}  ${pc.dim(report.path)}${missing}`)
    }
  }
  log()
}

async function runRemove(name: string): Promise<void> {
  const config = await loadConfig()
  const entries = await readRegistry(config.reposFile)
  if (!entries.some((entry) => entry.name === name)) {
    throw new WtError(`Unknown repo: ${name}`, { code: 'unknown_repo' })
  }
  await removeRepo(config.reposFile, name)
  if (getOutputContext().json) {
    emitJson({ ok: true, removed: name })
    return
  }
  success(`Unregistered ${name}`)
}
