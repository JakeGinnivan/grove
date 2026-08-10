import { Command } from 'commander'
import pc from 'picocolors'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { loadConfig } from '../core/config.js'
import { readRegistry, gitDirFor, writeRepo, removeRepo } from '../core/registry.js'
import { emitJson, log, success, getOutputContext } from '../core/output.js'
import { WtError } from '../core/errors.js'
import { isGitRepo } from '../core/git.js'
import { resolve } from 'node:path'

export function reposCommand(): Command {
  const command = new Command('repos')
    .description('List registered repos and their paths')
    .action(async () => {
      await runRepos()
    })

  command
    .command('add')
    .description('Register an existing local repo')
    .argument('<path>', 'path to the repo or its worktree parent directory')
    .option('-n, --name <name>', 'name to register (default: directory name)')
    .option('-a, --alias <alias>', 'short alias')
    .action(async (path, options) => {
      await runAdd(path, options)
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
    log(pc.dim('  Use `wt clone <url>` or `wt repos add <path>`.'))
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

async function runAdd(
  pathArg: string,
  options: { name?: string; alias?: string },
): Promise<void> {
  const config = await loadConfig()
  const path = resolve(pathArg)

  if (!existsSync(path)) {
    throw new WtError(`Path does not exist: ${path}`, { code: 'no_such_path' })
  }

  // Accept either a worktree parent (containing main/) or a plain clone.
  const isRepo = await isGitRepo(path)
  const hasMain = existsSync(join(path, 'main')) && (await isGitRepo(join(path, 'main')))
  if (!isRepo && !hasMain) {
    throw new WtError(`Not a git repo: ${path}`, {
      code: 'not_a_repo',
      hint: 'Point at a git repo or a directory containing a `main` checkout.',
    })
  }

  const name = options.name ?? deriveName(path, isRepo && !hasMain)
  await writeRepo(config.reposFile, name, path, options.alias)

  if (getOutputContext().json) {
    emitJson({ ok: true, name, path, alias: options.alias ?? null })
    return
  }
  success(`Registered ${pc.cyan(name)} → ${path}`)
}

function deriveName(path: string, isPlainClone: boolean): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  const last = segments.at(-1) ?? 'repo'
  // A plain clone at <parent>/<repo>/main should register as <repo>.
  if (!isPlainClone && last === 'main' && segments.length > 1) {
    return segments.at(-2) ?? last
  }
  return last
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
