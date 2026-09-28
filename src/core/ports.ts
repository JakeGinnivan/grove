import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { WtError } from './errors.js'
import { git, getConfig, listWorktrees, setConfig } from './git.js'
import { readRegistry } from './registry.js'
import { warn } from './output.js'

const BASE_KEY = 'grove.port.base'
const OVERFLOW_KEY = 'grove.port.lastOverflow'
const SLOT_FILE = 'grove-port-slot'
const COMPOSE_FILE = 'compose.override.yaml'

export interface PortService {
  offset: number
  dotenv?: DotenvPort
  compose?: ComposePort
}

export interface DotenvPort {
  path: string
  env: string
}

export interface ComposePort {
  service: string
  target: number
}

export interface PortLayout {
  perWorktree: number
  worktreeSlots: number
  services: Record<string, PortService>
}

export interface PortAssignment {
  slot: number
  basePort: number
  blockStart: number
  duplicate: boolean
  warning: string | null
}

function invalid(message: string): never {
  throw new WtError(`Invalid ports configuration: ${message}`, {
    code: 'invalid_ports_config',
  })
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validateOutputFile(file: unknown, label: string): asserts file is string {
  if (typeof file !== 'string' || !file || isAbsolute(file) ||
      file.split(/[\\/]/).includes('..')) {
    invalid(`${label} must be a relative path inside the worktree`)
  }
}

/** Port layout is read from main so all branches share one allocation rule. */
export async function readPortLayout(mainPath: string): Promise<PortLayout | undefined> {
  const path = join(mainPath, 'worktree.json')
  if (!existsSync(path)) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    // Existing setup commands treat malformed worktree.json as optional.
    // Preserve that behavior for repos that have not enabled ports.
    warn(`Could not parse ${path}; skipping port configuration.`)
    return undefined
  }
  if (parsed.ports === undefined) return undefined
  const raw = parsed.ports
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('ports must be an object')
  const value = raw as Record<string, unknown>
  if (!positiveInteger(value.perWorktree)) invalid('perWorktree must be a positive integer')
  const perWorktree = value.perWorktree as number
  const slots = value.worktreeSlots ?? 50
  if (!positiveInteger(slots)) invalid('worktreeSlots must be a positive integer')
  const services = value.services
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    invalid('services must be an object')
  }
  const validated: Record<string, PortService> = {}
  const offsets = new Set<number>()
  const destinations = new Set<string>()
  for (const [name, entry] of Object.entries(services as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid(`${name} must be an object`)
    const service = entry as Record<string, unknown>
    const offset = service.offset
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset >= perWorktree) {
      invalid(`${name}.offset must be within 0..${perWorktree - 1}`)
    }
    if (offsets.has(offset)) invalid(`service offset ${offset} is duplicated`)
    offsets.add(offset)
    for (const key of Object.keys(service)) {
      if (key !== 'offset' && key !== 'dotenv' && key !== 'compose') {
        invalid(`${name}.${key} is not supported`)
      }
    }
    let dotenv: DotenvPort | undefined
    if (service.dotenv !== undefined) {
      const config = service.dotenv
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        invalid(`${name}.dotenv must be an object`)
      }
      const fields = config as Record<string, unknown>
      for (const key of Object.keys(fields)) {
        if (key !== 'env' && key !== 'path') invalid(`${name}.dotenv.${key} is not supported`)
      }
      const env = fields.env
      const path = fields.path ?? '.env'
      if (typeof env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) {
        invalid(`${name}.dotenv.env must be an environment variable name`)
      }
      validateOutputFile(path, `${name}.dotenv.path`)
      const key = `${path}\0${env}`
      if (destinations.has(key)) invalid(`${path} has duplicate env key ${env}`)
      destinations.add(key)
      dotenv = { path, env }
    }
    let compose: ComposePort | undefined
    if (service.compose !== undefined) {
      const config = service.compose
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        invalid(`${name}.compose must be an object`)
      }
      const fields = config as Record<string, unknown>
      for (const key of Object.keys(fields)) {
        if (key !== 'service' && key !== 'target') {
          invalid(`${name}.compose.${key} is not supported`)
        }
      }
      const composeService = fields.service ?? name
      if (typeof composeService !== 'string' || !composeService || /[\r\n\u0000]/.test(composeService)) {
        invalid(`${name}.compose.service must be a service name`)
      }
      const target = fields.target
      if (!positiveInteger(target) || target > 65535) {
        invalid(`${name}.compose.target must be a port from 1 through 65535`)
      }
      compose = { service: composeService, target }
    }
    validated[name] = { offset, ...(dotenv ? { dotenv } : {}),
      ...(compose ? { compose } : {}) }
  }
  return { perWorktree, worktreeSlots: slots as number, services: validated }
}

export async function configuredBasePort(mainPath: string): Promise<number | undefined> {
  const raw = await getConfig(mainPath, BASE_KEY)
  if (raw === undefined) return undefined
  const port = Number(raw)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new WtError(`Invalid ${BASE_KEY}: ${raw}`, { code: 'invalid_base_port' })
  }
  return port
}

export async function configureBasePort(
  mainPath: string,
  reposFile: string,
  raw: string,
): Promise<number> {
  const base = Number(raw)
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(base) || base < 1) {
    throw new WtError(`Invalid base port: ${raw}`, { code: 'invalid_base_port' })
  }
  const layout = await readPortLayout(mainPath)
  if (layout) {
    const end = base + (layout.worktreeSlots + 1) * layout.perWorktree - 1
    if (end > 65535) {
      throw new WtError(`Port range ${base}–${end} exceeds 65535.`, { code: 'invalid_port_range' })
    }
    const seen = new Set<string>()
    for (const entry of await readRegistry(reposFile)) {
      if (seen.has(entry.path)) continue
      seen.add(entry.path)
      const otherMain = existsSync(join(entry.path, 'main')) ? join(entry.path, 'main') : entry.path
      if (resolve(otherMain) === resolve(mainPath)) continue
      if (!existsSync(otherMain)) continue
      const [otherLayout, otherBase] = await Promise.all([
        readPortLayout(otherMain), configuredBasePort(otherMain),
      ])
      if (!otherLayout || otherBase === undefined) continue
      const otherEnd = otherBase + (otherLayout.worktreeSlots + 1) * otherLayout.perWorktree - 1
      if (base <= otherEnd && otherBase <= end) {
        throw new WtError(
          `Port range ${base}–${end} overlaps ${entry.name} (${otherBase}–${otherEnd}).`,
          { code: 'port_range_overlap' },
        )
      }
    }
  }
  await setConfig(mainPath, BASE_KEY, String(base))
  return base
}

async function adminDir(worktreePath: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--absolute-git-dir'], { cwd: worktreePath })
  return stdout
}

async function assignedSlot(worktreePath: string): Promise<number | undefined> {
  if (!existsSync(worktreePath)) return undefined
  const path = join(await adminDir(worktreePath), SLOT_FILE)
  if (!existsSync(path)) return undefined
  const slot = Number((await readFile(path, 'utf8')).trim())
  if (!positiveInteger(slot)) {
    throw new WtError(`Invalid port slot in ${path}`, { code: 'invalid_port_slot' })
  }
  return slot
}

export async function assignPortSlot(
  mainPath: string,
  worktreePath: string,
  layout: PortLayout,
  basePort: number,
): Promise<PortAssignment> {
  const worktrees = await listWorktrees(mainPath)
  if (!worktrees.some((wt) => resolve(wt.path) === resolve(worktreePath))) {
    throw new WtError('Current directory is not a registered worktree.', { code: 'not_in_worktree' })
  }
  const main = worktrees[0]?.path
  const isMain = main && resolve(main) === resolve(worktreePath)
  let slot = isMain ? 0 : await assignedSlot(worktreePath)
  let duplicate = false
  if (slot === undefined) {
    const used = new Map<number, number>()
    for (const wt of worktrees.slice(1)) {
      if (resolve(wt.path) === resolve(worktreePath)) continue
      const other = await assignedSlot(wt.path)
      if (other !== undefined) used.set(other, (used.get(other) ?? 0) + 1)
    }
    for (let candidate = 1; candidate <= layout.worktreeSlots; candidate++) {
      if (!used.has(candidate)) { slot = candidate; break }
    }
    if (slot === undefined) {
      const last = Number((await getConfig(mainPath, OVERFLOW_KEY)) ?? '0')
      slot = (Number.isSafeInteger(last) && last >= 0 ? last % layout.worktreeSlots : 0) + 1
      await setConfig(mainPath, OVERFLOW_KEY, String(slot))
      duplicate = true
    }
    await writeFile(join(await adminDir(worktreePath), SLOT_FILE), `${slot}\n`, { flag: 'wx' })
  } else if (slot > 0) {
    const owners = await Promise.all(worktrees.slice(1).map((wt) => assignedSlot(wt.path)))
    duplicate = owners.filter((value) => value === slot).length > 1
  }
  const assigned = slot as number
  const blockStart = basePort + assigned * layout.perWorktree
  if (blockStart + layout.perWorktree - 1 > 65535) {
    throw new WtError('Assigned port block exceeds 65535.', { code: 'invalid_port_range' })
  }
  const otherSlots = await Promise.all(worktrees.slice(1).map((wt) => assignedSlot(wt.path)))
  const unique = new Set(otherSlots.filter((value): value is number => value !== undefined && value <= layout.worktreeSlots))
  const remaining = layout.worktreeSlots - unique.size
  const warning = duplicate
    ? `Port slot ${assigned} is shared with another worktree. Check running apps; review grove cleanup --merged --dry-run.`
    : remaining <= 5 && assigned !== 0
      ? `Only ${remaining} unique port slot(s) remain. Review grove cleanup --merged --dry-run.`
      : null
  if (warning) warn(warning)
  return { slot: assigned, basePort, blockStart, duplicate, warning }
}

export async function portsForWorktree(mainPath: string, worktreePath: string): Promise<{
  layout: PortLayout
  assignment: PortAssignment
}> {
  const layout = await readPortLayout(mainPath)
  if (!layout) throw new WtError('This repo has no ports section in worktree.json.', { code: 'ports_not_configured' })
  const base = await configuredBasePort(mainPath)
  if (base === undefined) {
    throw new WtError('This clone has no base port.', {
      code: 'base_port_missing',
      hint: 'Run `grove port configure --base-port <port>`.',
    })
  }
  if (base + (layout.worktreeSlots + 1) * layout.perWorktree - 1 > 65535) {
    throw new WtError('Configured port range exceeds 65535.', { code: 'invalid_port_range' })
  }
  return { layout, assignment: await assignPortSlot(mainPath, worktreePath, layout, base) }
}

/** Keep generated files inside the worktree, including through symlinks. */
async function outputPath(worktreePath: string, file: string): Promise<string> {
  const path = resolve(worktreePath, file)
  const rel = relative(worktreePath, path)
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    invalid(`${file} escapes worktree`)
  }
  await mkdir(dirname(path), { recursive: true })
  const [realWorktree, realParent] = await Promise.all([
    realpath(worktreePath), realpath(dirname(path)),
  ])
  if (realParent !== realWorktree && !realParent.startsWith(`${realWorktree}${sep}`)) {
    invalid(`${file} escapes worktree through a symlink`)
  }
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing?.isSymbolicLink()) invalid(`${file} is a symlink`)
  return path
}

/** Update only configured keys, after repo bootstrap has created env files. */
export async function generatePortEnv(
  worktreePath: string,
  layout: PortLayout,
  assignment: PortAssignment,
): Promise<string[]> {
  const files = new Map<string, Map<string, number>>()
  for (const service of Object.values(layout.services)) {
    if (!service.dotenv) continue
    const vars = files.get(service.dotenv.path) ?? new Map<string, number>()
    vars.set(service.dotenv.env, assignment.blockStart + service.offset)
    files.set(service.dotenv.path, vars)
  }
  const written: string[] = []
  for (const [file, vars] of files) {
    const path = await outputPath(worktreePath, file)
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing?.isSymbolicLink()) invalid(`${file} is a symlink`)
    const original = existing ? await readFile(path, 'utf8') : ''
    const lines = original ? original.split(/\r?\n/) : []
    if (lines.at(-1) === '') lines.pop()
    const seen = new Set<string>()
    const updated: string[] = []
    for (const line of lines) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
      const key = match?.[1]
      if (!key || !vars.has(key)) { updated.push(line); continue }
      if (!seen.has(key)) { updated.push(`${key}=${vars.get(key)}`); seen.add(key) }
    }
    for (const [key, port] of vars) {
      if (!seen.has(key)) updated.push(`${key}=${port}`)
    }
    await writeFile(path, `${updated.join('\n')}\n`, 'utf8')
    written.push(file)
  }
  return written
}

const COMPOSE_HEADER = '# Generated by Grove from worktree.json. Do not edit.'

/** Write a Grove-owned Compose override. `!override` replaces fixed base ports. */
export async function generatePortCompose(
  worktreePath: string,
  layout: PortLayout,
  assignment: PortAssignment,
): Promise<string[]> {
  type PublishedPort = { config: ComposePort; published: number }
  const services = new Map<string, PublishedPort[]>()
  for (const service of Object.values(layout.services)) {
    if (!service.compose) continue
    const { service: composeService, target } = service.compose
    const ports = services.get(composeService) ?? []
    if (ports.some((port) => port.config.target === target)) {
      invalid(`${COMPOSE_FILE} maps ${composeService} target ${target} more than once`)
    }
    ports.push({ config: service.compose, published: assignment.blockStart + service.offset })
    services.set(composeService, ports)
  }
  if (services.size === 0) return []
  const path = await outputPath(worktreePath, COMPOSE_FILE)
  if (existsSync(path)) {
    const original = await readFile(path, 'utf8')
    if (!original.startsWith(COMPOSE_HEADER + '\n')) {
      throw new WtError(`Refusing to overwrite existing Compose file: ${path}`, {
        code: 'compose_file_not_managed',
        hint: 'Grove owns compose.override.yaml when Compose projection is enabled.',
      })
    }
  }
  const lines = [COMPOSE_HEADER, 'services:']
  for (const [name, ports] of services) {
    lines.push(`  ${JSON.stringify(name)}:`, '    ports: !override')
    for (const { config, published } of ports) {
      lines.push(`      - ${JSON.stringify(`${published}:${config.target}`)}`)
    }
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return [COMPOSE_FILE]
}

export async function generatePortFiles(
  worktreePath: string,
  layout: PortLayout,
  assignment: PortAssignment,
): Promise<{ envFiles: string[]; composeFiles: string[] }> {
  const envFiles = await generatePortEnv(worktreePath, layout, assignment)
  const composeFiles = await generatePortCompose(worktreePath, layout, assignment)
  return { envFiles, composeFiles }
}
