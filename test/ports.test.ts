import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createSandbox, gitIn, runCli, type Sandbox } from './helpers/sandbox.js'

const execFileAsync = promisify(execFile)

let sandbox: Sandbox

beforeEach(async () => { sandbox = await createSandbox() })
afterEach(async () => { await sandbox.cleanup() })

async function layout(slots = 50, setup = false): Promise<void> {
  await writeFile(join(sandbox.mainPath, 'worktree.json'), JSON.stringify({
    ...(setup ? { 'setup-worktree': ["printf 'CUSTOM=yes\\nPORT=9999\\n' > .env"] } : {}),
    ports: {
      perWorktree: 20,
      worktreeSlots: slots,
      services: {
        webapp: { offset: 0, dotenv: { env: 'PORT' } },
        api: { offset: 1, dotenv: { env: 'API_PORT' } },
      },
    },
  }))
  const configured = await runCli(['port', 'configure', '--base-port', '3800', '--json'], sandbox, {
    PWD: sandbox.mainPath,
  })
  expect(configured.exitCode).toBe(0)
}

async function create(title: string): Promise<{ path: string; port: { slot: number; blockStart: number; duplicate: boolean }; portWarning: string | null }> {
  const result = await runCli(['new', 'demo', '--title', title, '--json'], sandbox)
  expect(result.exitCode).toBe(0)
  return result.json()
}

describe('worktree ports', () => {
  it('assigns main slot zero and the first free slot to new worktrees', async () => {
    await layout()
    const main = await runCli(['port', '--service', 'api', '--json'], sandbox, { PWD: sandbox.mainPath })
    expect(main.json<{ slot: number; port: number }>()).toMatchObject({ slot: 0, port: 3801 })
    const first = await create('first')
    expect(first.port).toMatchObject({ slot: 1, blockStart: 3820, duplicate: false })
    expect(await readFile(join(first.path, '.env'), 'utf8')).toContain('API_PORT=3821')
    const second = await create('second')
    expect(second.port.slot).toBe(2)
    const lookup = await runCli(['port', '--service', 'webapp'], sandbox, { PWD: first.path })
    expect(lookup.stdout.trim()).toBe('3820')
  })

  it('generates env after bootstrap, preserving unrelated values', async () => {
    await layout(50, true)
    const created = await runCli(['new', 'demo', '--title', 'bootstrapped', '--setup', '--json'], sandbox)
    expect(created.exitCode).toBe(0)
    const path = created.json<{ path: string }>().path
    const env = await readFile(join(path, '.env'), 'utf8')
    expect(env).toContain('CUSTOM=yes')
    expect(env).toContain('PORT=3820')
    expect(env).toContain('API_PORT=3821')
    expect(env).not.toContain('PORT=9999')
    const regenerated = await runCli(['port', '--generate-env', '--json'], sandbox, { PWD: path })
    expect(regenerated.exitCode).toBe(0)
    expect((await readFile(join(path, '.env'), 'utf8')).match(/^PORT=/gm)).toHaveLength(1)
  })

  it('writes dotenv variables to an optional service path', async () => {
    await writeFile(join(sandbox.mainPath, 'worktree.json'), JSON.stringify({
      ports: { perWorktree: 20, services: {
        web: { offset: 0, dotenv: { path: 'apps/web/.env.local', env: 'PORT' } },
      } },
    }))
    const configured = await runCli(['port', 'configure', '--base-port', '3800', '--json'], sandbox, {
      PWD: sandbox.mainPath,
    })
    expect(configured.exitCode).toBe(0)
    const created = await create('custom dotenv path')
    expect(await readFile(join(created.path, 'apps/web/.env.local'), 'utf8'))
      .toBe('PORT=3820\n')
  })

  it('reuses freed slots and wraps duplicate assignments in order', async () => {
    await layout(2)
    const first = await create('one')
    const second = await create('two')
    const removedSecond = await runCli(['cleanup', 'demo', second.path, '--force', '--no-trash', '--json'], sandbox)
    expect(removedSecond.exitCode).toBe(0)
    const reused = await create('replacement')
    expect(reused.port).toMatchObject({ slot: 2, duplicate: false })
    const overflow1 = await create('three')
    const overflow2 = await create('four')
    expect(overflow1.port).toMatchObject({ slot: 1, duplicate: true })
    expect(overflow2.port).toMatchObject({ slot: 2, duplicate: true })
    expect(overflow2.portWarning).toMatch(/shared/)
    const removed = await runCli(['cleanup', 'demo', first.path, '--force', '--no-trash', '--json'], sandbox)
    expect(removed.exitCode).toBe(0)
    // Slot 1 still has the first overflow worktree, so the next assignment wraps.
    const overflow3 = await create('five')
    expect(overflow3.port.slot).toBe(1)
    expect(overflow3.port.duplicate).toBe(true)
  })

  it('assigns an existing worktree when first queried', async () => {
    const old = await create('old')
    expect(old.port).toBeNull()
    await layout()
    const query = await runCli(['port', '--json'], sandbox, { PWD: old.path })
    expect(query.json<{ slot: number; port: number }>()).toMatchObject({ slot: 1, port: 3820 })
  })

  it('passes a service port to a launched process', async () => {
    await layout()
    const created = await create('launch')
    const result = await runCli([
      'port', 'exec', 'webapp', '--', process.execPath, '-e',
      'process.stdout.write(process.env.PORT)',
    ], sandbox, { PWD: created.path })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('3820')
  })

  it('rejects an imported repo range that overlaps another registered repo', async () => {
    await layout()
    const other = await createSandbox('other')
    try {
      await writeFile(join(other.mainPath, 'worktree.json'), JSON.stringify({
        ports: { perWorktree: 20, worktreeSlots: 50, services: { web: { offset: 0 } } },
      }))
      const conflict = await runCli([
        'repos', 'add', other.repoPath, '--name', 'other', '--base-port', '4000', '--json',
      ], sandbox)
      expect(conflict.exitCode).toBe(1)
      expect(conflict.json<{ error: { code: string } }>().error.code).toBe('port_range_overlap')
      const imported = await runCli([
        'repos', 'add', other.repoPath, '--name', 'other', '--base-port', '5000', '--json',
      ], sandbox)
      expect(imported.exitCode).toBe(0)
      expect(imported.json<{ basePort: number }>().basePort).toBe(5000)
    } finally {
      await other.cleanup()
    }
  })

  it('sets the base port and main env file when cloning a configured repo', async () => {
    await writeFile(join(sandbox.mainPath, 'worktree.json'), JSON.stringify({
      ports: { perWorktree: 20, services: { web: { offset: 0, dotenv: { env: 'PORT' } } } },
    }))
    await gitIn(['add', 'worktree.json'], sandbox.mainPath)
    await gitIn(['commit', '-m', 'configure ports'], sandbox.mainPath)
    await gitIn(['push', 'origin', 'main'], sandbox.mainPath)
    const cloned = await runCli([
      'clone', sandbox.remote, 'clone-with-ports', '--base-port', '5000', '--no-alias', '--json',
    ], sandbox)
    expect(cloned.exitCode).toBe(0)
    const result = cloned.json<{ mainPath: string; basePort: number }>()
    expect(result.basePort).toBe(5000)
    expect(await readFile(join(result.mainPath, '.env'), 'utf8')).toBe('PORT=5000\n')
  })

  it('generates a local Compose override from the same service offsets', async () => {
    await writeFile(join(sandbox.mainPath, 'worktree.json'), JSON.stringify({
      ports: {
        perWorktree: 20,
        services: {
          webapp: {
            offset: 0, dotenv: { env: 'PORT' },
            compose: { target: 3000 },
          },
          metrics: {
            offset: 1,
            compose: { service: 'webapp', target: 9090 },
          },
        },
      },
    }))
    const configured = await runCli(['port', 'configure', '--base-port', '3800', '--json'], sandbox, {
      PWD: sandbox.mainPath,
    })
    expect(configured.exitCode).toBe(0)
    const created = await create('compose')
    const override = await readFile(join(created.path, 'compose.override.yaml'), 'utf8')
    expect(override).toContain('ports: !override')
    expect(override).toContain('"3820:3000"')
    expect(override).toContain('"3821:9090"')
    expect(await readFile(join(created.path, '.env'), 'utf8')).toContain('PORT=3820')
    expect(override).not.toContain('environment:')
    const regenerate = await runCli(['port', '--generate', '--json'], sandbox, { PWD: created.path })
    expect(regenerate.json<{ composeFiles: string[] }>().composeFiles).toEqual(['compose.override.yaml'])

    // When a recent Compose CLI is available, verify that !override actually
    // removes a fixed base mapping instead of adding another published port.
    const version = await execFileAsync('docker', ['compose', 'version', '--short'])
      .then(({ stdout }) => /v?(\d+)\.(\d+)\.(\d+)/.exec(stdout))
      .catch(() => null)
    const major = Number(version?.[1] ?? 0)
    const minor = Number(version?.[2] ?? 0)
    const patch = Number(version?.[3] ?? 0)
    if (major > 2 || (major === 2 && (minor > 24 || (minor === 24 && patch >= 4)))) {
      await writeFile(join(created.path, 'compose.yaml'),
        'services:\n  webapp:\n    image: busybox\n    ports:\n      - "3000:3000"\n')
      const { stdout } = await execFileAsync('docker', [
        'compose', 'config', '--format', 'json',
      ], { cwd: created.path })
      const merged = JSON.parse(stdout) as {
        services: { webapp: { ports: { published: string }[] } }
      }
      expect(merged.services.webapp.ports.map((port) => port.published).sort())
        .toEqual(['3820', '3821'])
    }
  })

  it('refuses to overwrite an existing hand-written Compose override', async () => {
    await writeFile(join(sandbox.mainPath, 'worktree.json'), JSON.stringify({
      ports: { perWorktree: 20, services: {
        web: { offset: 0, compose: { service: 'web', target: 3000 } },
      } },
    }))
    const configured = await runCli(['port', 'configure', '--base-port', '3800', '--json'], sandbox, {
      PWD: sandbox.mainPath,
    })
    expect(configured.exitCode).toBe(0)
    await writeFile(join(sandbox.mainPath, 'compose.override.yaml'), 'services:\n  web:\n    environment:\n      DEBUG: true\n')
    const regenerate = await runCli(['port', '--generate-compose', '--json'], sandbox, {
      PWD: sandbox.mainPath,
    })
    expect(regenerate.exitCode).toBe(1)
    expect(regenerate.json<{ error: { code: string } }>().error.code).toBe('compose_file_not_managed')
    expect(await readFile(join(sandbox.mainPath, 'compose.override.yaml'), 'utf8')).toContain('DEBUG: true')
  })

  it('rejects a custom Compose filename until it is supported', async () => {
    await writeFile(join(sandbox.mainPath, 'worktree.json'), JSON.stringify({
      ports: { perWorktree: 20, services: {
        web: { offset: 0, compose: { target: 3000, file: 'compose.local.yaml' } },
      } },
    }))
    const configured = await runCli(['port', 'configure', '--base-port', '3800', '--json'], sandbox, {
      PWD: sandbox.mainPath,
    })
    expect(configured.exitCode).toBe(1)
    expect(configured.json<{ error: { code: string } }>().error.code).toBe('invalid_ports_config')
  })
})
