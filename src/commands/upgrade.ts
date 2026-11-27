import { execFile, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Command } from 'commander'
import pc from 'picocolors'
import { emitJson, getOutputContext, info, log, success, warn } from '../core/output.js'
import { WtError } from '../core/errors.js'
import { fetchLatestVersion, isNewer, isVersion, locateInstall, quoteForCmd, UPGRADE_HINT } from '../core/upgrade.js'
import { hasInstalledSkills } from './skills.js'

const execFileAsync = promisify(execFile)

export function upgradeCommand(currentVersion: string): Command {
  return new Command('upgrade')
    .description('Upgrade grove to the latest release with the package manager that installed it')
    .option('--check', 'report whether a newer release exists, without installing it')
    .action(async (options: { check?: boolean }) => {
      const json = getOutputContext().json
      const cliPath = realpathSync(fileURLToPath(import.meta.url))
      const started = process.argv[1] ? resolve(process.argv[1]) : undefined
      const install = locateInstall(started, cliPath)
      const latest = await fetchLatestVersion()
      const available = isNewer(latest, currentVersion)
      const result = {
        current: currentVersion,
        latest,
        method: install?.method ?? null,
        command: install?.command ?? null,
      }

      if (!available) {
        if (json) emitJson({ ok: true, ...result, upgraded: false })
        else success(`grove ${currentVersion} is the latest release.`)
        return
      }

      if (options.check) {
        if (json) emitJson({ ok: true, ...result, upgraded: false })
        else {
          info(`grove ${latest} is available; this is ${currentVersion}.`)
          log(`  Run ${pc.bold('grove upgrade')} to install it${install ? ` with ${install.method}` : ''}.`)
        }
        return
      }

      if (!install) {
        throw new WtError(`grove ${latest} is available, but grove can't tell how it was installed.`, {
          code: 'unknown_install',
          hint: `grove is running from ${cliPath}. Upgrade it with the tool that installed it:\n  ${UPGRADE_HINT}`,
        })
      }

      const [program, ...args] = install.command as [string, ...string[]]
      log(`Upgrading grove ${currentVersion} → ${latest} with ${install.method}`)
      log(pc.dim(`$ ${install.command.join(' ')}`))
      const exitCode = await run(program, args, json)
      if (exitCode !== 0) {
        throw new WtError(`${install.method} exited with code ${exitCode} while upgrading grove.`, {
          code: 'upgrade_failed',
          hint: `Run it yourself to see what went wrong: ${install.command.join(' ')}`,
        })
      }

      // A package manager can exit 0 without moving, for example when it holds
      // back releases younger than a minimum release age. Only the grove that
      // new shells will run can say whether it worked.
      const installed = await versionOnPath()
      const upgraded = installed !== null && !isNewer(latest, installed)
      if (json) {
        emitJson({ ok: true, ...result, installed, upgraded })
        return
      }
      if (upgraded) {
        success(`Upgraded grove to ${installed}.`)
      } else if (installed === null) {
        warn(`${install.method} finished, but there is no grove on PATH to confirm the upgrade with.`)
      } else {
        warn(`${install.method} finished, but grove on PATH is still ${installed}.`)
        info(`If ${install.method} holds back new releases for a while, its output above says so.`)
        return
      }
      // This process is still the old grove carrying the old skills, so it
      // can't tell whether the new release changed them.
      if (await hasInstalledSkills()) {
        info('Run `grove skills install` to bring your agents\' skills up to date.')
      }
    })
}

/**
 * Child processes run from the home directory, not wherever grove was started.
 * Yarn reads config files from the directory it runs in, a version manager's
 * shim picks the tool from that directory's config, and on Windows cmd.exe
 * runs a matching npm.cmd or grove.cmd from the current directory before
 * searching PATH. Any of those would let a cloned repo choose what runs.
 */
const SAFE_CWD = homedir()

const WINDOWS = process.platform === 'win32'

/** What `grove --version` prints for the grove on PATH, or null if there is none. */
async function versionOnPath(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('grove', ['--version'], {
      cwd: SAFE_CWD,
      shell: WINDOWS,
      timeout: 15_000,
    })
    const version = stdout.trim()
    return isVersion(version) ? version : null
  } catch {
    return null
  }
}

/**
 * Run the package manager with its output shown live. Under --json its stdout
 * goes to stderr, so stdout carries only grove's JSON.
 */
function run(program: string, args: string[], json: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, WINDOWS ? quoteForCmd(args) : args, {
      cwd: SAFE_CWD,
      stdio: ['inherit', json ? process.stderr : 'inherit', 'inherit'],
      // npm, pnpm and yarn are .cmd shims on Windows, which only a shell runs.
      shell: WINDOWS,
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new WtError(`${program} isn't on PATH, so grove can't upgrade itself with it.`, {
          code: 'package_manager_missing',
          hint: `Run the upgrade from a shell where ${program} works: ${[program, ...args].join(' ')}`,
        }))
      } else {
        reject(error)
      }
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}
