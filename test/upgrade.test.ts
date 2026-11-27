import { describe, expect, it as plainIt, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmod, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { detectInstall, isNewer, locateInstall, PACKAGE_NAME } from '../src/core/upgrade.js'
import { runCli } from './helpers/sandbox.js'
import { it } from './helpers/fixtures.js'
import { expectError } from './helpers/grove.js'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const VERSION = (JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { version: string }).version

describe('detectInstall', () => {
  plainIt('finds npm and upgrades into the same prefix', () => {
    expect(detectInstall('/opt/homebrew/lib/node_modules/@jakeginnivan/grove/dist/cli.mjs', 'darwin')).toEqual({
      method: 'npm',
      command: ['npm', 'install', '--global', '--prefix', '/opt/homebrew', `${PACKAGE_NAME}@latest`],
    })
    // npm under a version manager's node keeps that node's prefix.
    expect(detectInstall('/home/a/.local/share/mise/installs/node/24.1.0/lib/node_modules/@jakeginnivan/grove/dist/cli.mjs', 'linux')?.command)
      .toContain('/home/a/.local/share/mise/installs/node/24.1.0')
    expect(detectInstall('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@jakeginnivan\\grove\\dist\\cli.mjs', 'win32')?.command)
      .toContain('C:\\Users\\a\\AppData\\Roaming\\npm')
  })

  plainIt('finds pnpm', () => {
    for (const path of [
      '/Users/a/.local/share/pnpm/global/v11/.pnpm/@jakeginnivan+grove@0.14.0/node_modules/@jakeginnivan/grove/dist/cli.mjs',
      '/Users/a/Library/pnpm/global/5/node_modules/.pnpm/@jakeginnivan+grove@0.14.0/node_modules/@jakeginnivan/grove/dist/cli.mjs',
    ]) {
      expect(detectInstall(path, 'darwin')?.method).toBe('pnpm')
    }
    expect(detectInstall('C:\\Users\\a\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@jakeginnivan\\grove\\dist\\cli.mjs', 'win32')?.method)
      .toBe('pnpm')
  })

  plainIt('finds yarn classic', () => {
    expect(detectInstall('/home/a/.config/yarn/global/node_modules/@jakeginnivan/grove/dist/cli.mjs', 'linux')?.method).toBe('yarn')
    expect(detectInstall('C:\\Users\\a\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\@jakeginnivan\\grove\\dist\\cli.mjs', 'win32')?.method)
      .toBe('yarn')
  })

  plainIt('finds mise before the npm layout inside it', () => {
    expect(detectInstall('/home/a/.local/share/mise/installs/npm-jakeginnivan-grove/0.14.0/lib/node_modules/@jakeginnivan/grove/dist/cli.mjs', 'linux'))
      .toEqual({ method: 'mise', command: ['mise', 'upgrade', `npm:${PACKAGE_NAME}`] })
  })

  plainIt('declines anything that is not a global install', () => {
    expect(detectInstall('/Users/a/_code/grove/main/dist/cli.mjs', 'darwin')).toBeNull()
    expect(detectInstall('/Users/a/.npm/_npx/1234/node_modules/@jakeginnivan/grove/dist/cli.mjs', 'darwin')).toBeNull()
    expect(detectInstall('/Users/a/app/node_modules/@jakeginnivan/grove/dist/cli.mjs', 'darwin')).toBeNull()
  })
})

describe('locateInstall', () => {
  const store = '/Users/a/.local/share/pnpm/store/v11/links/@jakeginnivan/grove/0.14.0/279d/node_modules/@jakeginnivan/grove/dist/cli.mjs'

  plainIt('finds pnpm 11 from its shim path or the store path shell integration uses', () => {
    const shim = '/Users/a/.local/share/pnpm/global/v11/5c55/node_modules/@jakeginnivan/grove/dist/cli.mjs'
    expect(locateInstall(shim, store, 'darwin')?.method).toBe('pnpm')
    expect(locateInstall(store, store, 'darwin')?.method).toBe('pnpm')
  })

  plainIt('trusts a project install over a real path in the shared store', () => {
    expect(locateInstall('/Users/a/app/node_modules/@jakeginnivan/grove/dist/cli.mjs', store, 'darwin')).toBeNull()
    expect(locateInstall('/Users/a/app/node_modules/.bin/grove', store, 'darwin')).toBeNull()
  })

  plainIt('falls back to the real path for a symlinked global bin', () => {
    expect(locateInstall('/usr/local/bin/grove', '/usr/local/lib/node_modules/@jakeginnivan/grove/dist/cli.mjs', 'darwin')?.method)
      .toBe('npm')
  })
})

describe('isNewer', () => {
  plainIt('compares numerically, not as strings', () => {
    expect(isNewer('0.15.0', '0.14.0')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.14.0', '0.14.0')).toBe(false)
    expect(isNewer('0.13.9', '0.14.0')).toBe(false)
  })

  plainIt('sorts a prerelease below its release', () => {
    expect(isNewer('1.0.0', '1.0.0-next.1')).toBe(true)
    expect(isNewer('1.0.0-next.1', '1.0.0')).toBe(false)
  })
})

describe('grove upgrade', () => {
  let server: Server
  let registry: string
  let latest = VERSION

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === `/${PACKAGE_NAME.replace('/', '%2F')}/latest`) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ name: PACKAGE_NAME, version: latest }))
      } else {
        response.statusCode = 404
        response.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('says so when already on the latest release', async ({ sandbox }) => {
    latest = VERSION
    const result = await runCli(['upgrade', '--json'], sandbox, { npm_config_registry: registry })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.json()).toMatchObject({ ok: true, current: VERSION, latest: VERSION, upgraded: false })
  })

  it('reports a newer release with --check and installs nothing', async ({ sandbox }) => {
    latest = '999.0.0'
    const result = await runCli(['upgrade', '--check', '--json'], sandbox, { npm_config_registry: registry })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.json()).toMatchObject({ ok: true, latest: '999.0.0', upgraded: false })
  })

  it('refuses to guess for a checkout that is not a global install', async ({ sandbox }) => {
    latest = '999.0.0'
    const result = await runCli(['upgrade', '--json'], sandbox, { npm_config_registry: registry })
    const error = expectError(result, 'unknown_install')
    expect(error.hint).toContain('npm install --global')
  })

  // A fake npm prefix holding a copy of the build, and a fake npm that records
  // how it was called. The fake is a shell script, so this is POSIX only.
  it.skipIf(process.platform === 'win32')('runs npm against the prefix grove was installed into', async ({ sandbox }) => {
    latest = '999.0.0'
    const prefix = join(sandbox.root, 'npm-prefix')
    const pkg = join(prefix, 'lib/node_modules', PACKAGE_NAME)
    await mkdir(pkg, { recursive: true })
    await cp(join(projectRoot, 'dist'), join(pkg, 'dist'), { recursive: true })
    await cp(join(projectRoot, 'package.json'), join(pkg, 'package.json'))
    await symlink(join(projectRoot, 'node_modules'), join(pkg, 'node_modules'))

    const bin = join(sandbox.root, 'fake-bin')
    const record = join(sandbox.root, 'npm-args')
    await mkdir(bin)
    await writeFile(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\necho installed-by-fake-npm\n`)
    await chmod(join(bin, 'npm'), 0o755)

    const { stdout } = await execFileAsync(process.execPath, [join(pkg, 'dist/cli.mjs'), 'upgrade', '--json'], {
      env: {
        ...process.env,
        HOME: sandbox.root,
        USERPROFILE: sandbox.root,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        npm_config_registry: registry,
      },
    })
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, method: 'npm', latest: '999.0.0', upgraded: true })
    expect((await readFile(record, 'utf8')).trim().split('\n'))
      .toEqual(['install', '--global', '--prefix', realpathSync(prefix), `${PACKAGE_NAME}@latest`])
  })
})
