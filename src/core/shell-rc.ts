import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { WtError } from './errors.js'

export const SHELLS = ['zsh', 'bash', 'fish', 'powershell'] as const
export type Shell = (typeof SHELLS)[number]

export function parseShell(name: string): Shell {
  if (name === 'pwsh') return 'powershell'
  if ((SHELLS as readonly string[]).includes(name)) return name as Shell
  throw new WtError(`Unsupported shell: ${name}`, {
    code: 'unsupported_shell',
    hint: 'Supported: zsh, bash, fish, powershell.',
  })
}

export function detectShell(): Shell {
  if (process.platform === 'win32') return 'powershell'
  const shellPath = process.env['SHELL'] ?? ''
  if (shellPath.includes('fish')) return 'fish'
  if (shellPath.includes('bash')) return 'bash'
  return 'zsh'
}

export interface InitOptions {
  name: string
  completions: boolean
}

/**
 * Startup files the shell reads, most preferred first. The first is where
 * install writes; all of them count when checking for an existing line, so a
 * hand-written one in another file is not duplicated.
 */
export function startupFiles(shell: Shell): string[] {
  const home = homedir()
  const xdgConfig = process.env['XDG_CONFIG_HOME'] || join(home, '.config')
  switch (shell) {
    case 'zsh':
      return [join(process.env['ZDOTDIR'] || home, '.zshrc')]
    case 'bash': {
      // macOS terminals start login shells, which read .bash_profile and not
      // .bashrc; Linux terminals start interactive shells, which do the opposite.
      const files = [join(home, '.bashrc'), join(home, '.bash_profile')]
      return process.platform === 'darwin' ? files.reverse() : files
    }
    case 'fish':
      // conf.d gives grove a file of its own instead of editing config.fish.
      return [join(xdgConfig, 'fish', 'conf.d', 'grove.fish'), join(xdgConfig, 'fish', 'config.fish')]
    case 'powershell':
      // The completions need PowerShell 7, whose profile lives here (not under
      // WindowsPowerShell, which is 5.1's).
      return [
        process.platform === 'win32'
          ? join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
          : join(xdgConfig, 'powershell', 'Microsoft.PowerShell_profile.ps1'),
      ]
  }
}

/** The line a startup file needs to load the integration. */
export function initLine(shell: Shell, options: InitOptions): string {
  const args: string[] = [shell]
  if (options.name !== 'wt') args.push('--name', options.name)
  if (!options.completions) args.push('--no-completions')
  const command = `grove shell-init ${args.join(' ')}`
  switch (shell) {
    case 'zsh':
    case 'bash':
      return `eval "$(${command})"`
    case 'fish':
      return `${command} | source`
    case 'powershell':
      return `Invoke-Expression (& ${command} | Out-String)`
  }
}

export interface ShellIntegrationStatus {
  shell: Shell
  /** Where install writes. */
  rcFile: string
  /** The startup file that already loads grove, if any. */
  installedIn: string | undefined
}

export async function shellIntegrationStatus(shell: Shell): Promise<ShellIntegrationStatus> {
  const files = startupFiles(shell)
  let installedIn: string | undefined
  for (const file of files) {
    if (!existsSync(file)) continue
    if ((await readFile(file, 'utf8')).includes('grove shell-init')) {
      installedIn = file
      break
    }
  }
  return { shell, rcFile: files[0]!, installedIn }
}

export interface InstallResult extends ShellIntegrationStatus {
  line: string
  changed: boolean
}

/**
 * Append the init line to the shell's startup file unless one already loads
 * grove. Appending keeps it after zsh's compinit, which completions need, and
 * writes through a symlinked rc file rather than replacing it.
 */
export async function installShellIntegration(
  shell: Shell,
  options: InitOptions,
): Promise<InstallResult> {
  const status = await shellIntegrationStatus(shell)
  const line = initLine(shell, options)
  if (status.installedIn) return { ...status, line, changed: false }

  const file = status.rcFile
  await mkdir(dirname(file), { recursive: true })
  const existing = existsSync(file) ? await readFile(file, 'utf8') : ''
  const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  await appendFile(file, `${separator}# grove shell integration: the \`${options.name}\` command and completions\n${line}\n`)
  return { ...status, installedIn: file, line, changed: true }
}
