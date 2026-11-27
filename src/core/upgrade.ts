import { WtError } from './errors.js'

export const PACKAGE_NAME = '@jakeginnivan/grove'

export type InstallMethod = 'npm' | 'pnpm' | 'yarn' | 'mise'

export interface Install {
  method: InstallMethod
  /** The program to run and its arguments. */
  command: string[]
}

/**
 * Work out how grove was installed from where its own script lives, and the
 * command that upgrades that install.
 *
 * The path is the only reliable signal. Asking each package manager whether
 * it owns grove is slow, and a machine with several of them could answer yes
 * from more than one. `cliPath` must be the real path, with symlinks
 * resolved, since every manager links its global bin to somewhere else.
 *
 * Returns null for anything that isn't a global install: a dev checkout, npx,
 * or `pnpm link`. Upgrading those means something different each time.
 */
export function detectInstall(cliPath: string, platform: NodeJS.Platform = process.platform): Install | null {
  const path = cliPath.replace(/\\/g, '/')
  const windows = platform === 'win32'
  const lower = path.toLowerCase()

  // mise's npm backend installs each version under installs/npm-<name>/, and
  // inside that it looks like an npm prefix, so it has to be checked first.
  if (/\/mise\/installs\/npm-[^/]+\//.test(path)) {
    return { method: 'mise', command: ['mise', 'upgrade', `npm:${PACKAGE_NAME}`] }
  }

  // $PNPM_HOME/global/<layout version>/..., with PNPM_HOME defaulting to
  // ~/.local/share/pnpm, ~/Library/pnpm or %LOCALAPPDATA%\pnpm. pnpm 11
  // links global packages from its global virtual store, so the real path is
  // <store>/v<n>/links/... instead.
  if (/\/pnpm\/(global|store\/v\d+\/links)\//.test(windows ? lower : path)) {
    return { method: 'pnpm', command: ['pnpm', 'add', '--global', `${PACKAGE_NAME}@latest`] }
  }

  // Yarn classic: ~/.config/yarn/global, ~/.yarn/global, or
  // %LOCALAPPDATA%\Yarn\Data\global. Yarn 2+ has no global installs.
  if (/\/yarn\/(data\/)?global\/node_modules\//.test(lower)) {
    return { method: 'yarn', command: ['yarn', 'global', 'add', `${PACKAGE_NAME}@latest`] }
  }

  // npm puts global packages in <prefix>/lib/node_modules, or
  // <prefix>\node_modules on Windows. The prefix is passed explicitly: the npm
  // on PATH may belong to a different node, under a version manager that
  // picks node per directory, and would install a second copy elsewhere.
  const marker = `/node_modules/${PACKAGE_NAME}/`
  const at = path.lastIndexOf(marker)
  if (at !== -1 && !path.slice(0, at).includes('/node_modules/')) {
    const parent = path.slice(0, at)
    let prefix: string | null = null
    if (parent.endsWith('/lib')) prefix = parent.slice(0, -'/lib'.length)
    else if (windows && /\/npm$/i.test(parent)) prefix = parent
    if (prefix) {
      const nativePrefix = windows ? prefix.replace(/\//g, '\\') : prefix
      return {
        method: 'npm',
        command: ['npm', 'install', '--global', '--prefix', nativePrefix, `${PACKAGE_NAME}@latest`],
      }
    }
  }

  return null
}

/**
 * Detect the install from the script path grove was started with, then from
 * its real path.
 *
 * The started path keeps what the real path loses: pnpm's bin shim starts
 * grove through $PNPM_HOME/global, which links into a store a project install
 * can share. Started from a project's node_modules, it is a project install,
 * whatever the real path says. The real path still matters, because shell
 * integration starts grove by its real path.
 */
export function locateInstall(
  startedPath: string | undefined,
  realPath: string,
  platform: NodeJS.Platform = process.platform,
): Install | null {
  if (startedPath) {
    const install = detectInstall(startedPath, platform)
    if (install) return install
    if (startedPath.replace(/\\/g, '/').includes('/node_modules/')) return null
  }
  return detectInstall(realPath, platform)
}

/** The commands for each supported install, for when grove can't tell which it is. */
export const UPGRADE_HINT = [
  `npm install --global ${PACKAGE_NAME}@latest`,
  `pnpm add --global ${PACKAGE_NAME}@latest`,
  `yarn global add ${PACKAGE_NAME}@latest`,
  `mise upgrade npm:${PACKAGE_NAME}`,
].join('\n  ')

/**
 * Whether version `a` is newer than `b`. Only major.minor.patch counts; a
 * prerelease sorts below its release, which is all grove's tags need.
 */
export function isNewer(a: string, b: string): boolean {
  const parse = (version: string) => {
    const [core = '', pre] = version.replace(/^v/, '').split('-', 2)
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return left.pre === undefined && right.pre !== undefined
}

/**
 * The version the registry tags `latest`. Honours npm_config_registry, which
 * npm, pnpm and yarn all set for scripts they run and which users set to
 * point at a mirror.
 */
export async function fetchLatestVersion(): Promise<string> {
  const registry = (process.env['npm_config_registry'] || 'https://registry.npmjs.org').replace(/\/+$/, '')
  const url = `${registry}/${PACKAGE_NAME.replace('/', '%2F')}/latest`
  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new WtError(`Could not reach the npm registry to check grove's latest version.`, {
      code: 'registry_unreachable',
      hint: `${url}: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  if (!response.ok) {
    throw new WtError(`The npm registry answered ${response.status} for grove's latest version.`, {
      code: 'registry_error',
      hint: url,
    })
  }
  const body = (await response.json()) as { version?: unknown }
  if (typeof body.version !== 'string') {
    throw new WtError(`The npm registry's answer for grove's latest version has no version.`, {
      code: 'registry_error',
      hint: url,
    })
  }
  return body.version
}
