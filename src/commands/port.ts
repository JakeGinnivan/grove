import { spawn } from 'node:child_process'
import { Command } from 'commander'
import { git, listWorktrees } from '../core/git.js'
import { loadConfig } from '../core/config.js'
import {
  configureBasePort,
  generatePortCompose,
  generatePortEnv,
  generatePortFiles,
  portsForWorktree,
  readPortLayout,
} from '../core/ports.js'
import { emitJson, getOutputContext, success } from '../core/output.js'
import { WtError } from '../core/errors.js'

async function currentWorktree(): Promise<{ mainPath: string; path: string }> {
  const top = await git(['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(), allowFailure: true,
  })
  if (top.exitCode !== 0) {
    throw new WtError('Run this command inside a Git worktree.', { code: 'not_in_worktree' })
  }
  const worktrees = await listWorktrees(top.stdout)
  const mainPath = worktrees[0]?.path
  if (!mainPath) throw new WtError('Could not find the main worktree.', { code: 'not_in_worktree' })
  return { mainPath, path: top.stdout }
}

export function portCommand(): Command {
  const command = new Command('port')
    .description('Print or generate ports for the current worktree')
    .option('--service <name>', 'print a configured service port')
    .option('--generate-env', 'write configured port variables into env files')
    .option('--generate-compose', 'write configured local Compose override files')
    .option('--generate', 'regenerate all configured port files')
    .action(async (options: { service?: string; generateEnv?: boolean; generateCompose?: boolean; generate?: boolean }) => {
      const current = await currentWorktree()
      const { layout, assignment } = await portsForWorktree(current.mainPath, current.path)
      const service = options.service ? layout.services[options.service] : undefined
      if (options.service && !service) {
        throw new WtError(`Unknown port service: ${options.service}`, {
          code: 'unknown_port_service',
          hint: `Available: ${Object.keys(layout.services).join(', ')}`,
        })
      }
      const files = options.generate
        ? await generatePortFiles(current.path, layout, assignment)
        : {
          envFiles: options.generateEnv
            ? await generatePortEnv(current.path, layout, assignment) : [],
          composeFiles: options.generateCompose
            ? await generatePortCompose(current.path, layout, assignment) : [],
        }
      const port = assignment.blockStart + (service?.offset ?? 0)
      if (getOutputContext().json) {
        emitJson({ ok: true, path: current.path, slot: assignment.slot, port,
          service: options.service ?? null, duplicate: assignment.duplicate,
          warning: assignment.warning, ...files })
      } else {
        process.stdout.write(`${port}\n`)
      }
    })

  command.command('configure')
    .description('Set the local base port for this clone')
    .requiredOption('--base-port <port>', 'first port in the main checkout block')
    .action(async (options: { basePort: string }) => {
      const current = await currentWorktree()
      const config = await loadConfig()
      const basePort = await configureBasePort(current.mainPath, config.reposFile, options.basePort)
      if (await readPortLayout(current.mainPath)) {
        const { layout, assignment } = await portsForWorktree(current.mainPath, current.path)
        await generatePortFiles(current.path, layout, assignment)
      }
      if (getOutputContext().json) emitJson({ ok: true, basePort })
      else success(`Base port set to ${basePort}`)
    })

  command.command('exec')
    .description('Run a command with a service port set in its environment')
    .argument('<service>', 'configured service name')
    .argument('<program>', 'program to run')
    .argument('[args...]', 'program arguments')
    .allowUnknownOption()
    .action(async (name: string, program: string, args: string[]) => {
      const current = await currentWorktree()
      const { layout, assignment } = await portsForWorktree(current.mainPath, current.path)
      const service = layout.services[name]
      if (!service) throw new WtError(`Unknown port service: ${name}`, { code: 'unknown_port_service' })
      if (!service.dotenv) {
        throw new WtError(`Service ${name} has no dotenv variable configured.`, {
          code: 'port_service_has_no_env',
        })
      }
      const port = assignment.blockStart + service.offset
      const exit = await new Promise<number>((resolve, reject) => {
        const child = spawn(program, args, {
          cwd: process.cwd(),
          env: { ...process.env, [service.dotenv!.env]: String(port) },
          stdio: 'inherit',
        })
        child.on('error', reject)
        child.on('close', (code) => resolve(code ?? 1))
      })
      process.exitCode = exit
    })

  return command
}
