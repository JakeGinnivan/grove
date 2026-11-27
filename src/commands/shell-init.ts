import { Command } from 'commander'
import { realpathSync } from 'node:fs'
import { tildify } from '../core/config.js'
import { CD_SENTINEL, emitJson, getOutputContext, info, log, success } from '../core/output.js'
import {
  detectShell,
  installShellIntegration,
  parseShell,
  type InitOptions,
  type Shell,
} from '../core/shell-rc.js'
import { TARGET_NAMES } from './skills.js'
import { WtError } from '../core/errors.js'

/** Agent tools offered as `--target` completions. */
const AGENT_TARGETS = TARGET_NAMES

/**
 * Emits a shell function named `wt` that wraps the `grove` binary, plus tab
 * completion. A child process cannot change its parent's working directory,
 * so the binary prints a sentinel line and the wrapper performs the cd.
 */
export function shellInitCommand(): Command {
  return new Command('shell-init')
    .description('Print shell integration: the `wt` function and completions')
    .argument('[shell]', 'zsh, bash, fish, or powershell (default: auto)')
    .option('--name <name>', 'name for the shell function', 'wt')
    .option('--no-completions', 'emit only the function, without completions')
    .option('--install', "add the integration to your shell's startup file")
    .action(async (shellArg: string | undefined, options: ShellInitOptions) => {
      // The name is written unquoted into function definitions, completion
      // registrations and the startup file line.
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(options.name)) {
        throw new WtError(`--name must be a plain command name, not ${JSON.stringify(options.name)}.`, {
          code: 'invalid_name',
          hint: 'Use letters, digits, - and _, starting with a letter or _.',
        })
      }
      const shell = shellArg === undefined ? detectShell() : parseShell(shellArg)
      if (options.install) {
        await runInstall(shell, options)
        return
      }
      process.stdout.write(`${scriptFor(shell, options)}\n`)
    })
}

interface ShellInitOptions extends InitOptions {
  install?: boolean
}

async function runInstall(shell: Shell, options: InitOptions): Promise<void> {
  const result = await installShellIntegration(shell, options)
  if (getOutputContext().json) {
    emitJson({ ok: true, ...result })
    return
  }
  if (!result.changed) {
    info(`Shell integration is already in ${tildify(result.installedIn!)}`)
    return
  }
  success(`Added shell integration to ${tildify(result.rcFile)}`)
  log(`  Open a new terminal, or run: ${reloadCommand(shell, result.rcFile)}`)
}

function reloadCommand(shell: Shell, rcFile: string): string {
  return shell === 'powershell' ? `. $PROFILE` : `source ${tildify(rcFile)}`
}

function scriptFor(shell: Shell, options: InitOptions): string {
  const launcher = currentLauncher()
  switch (shell) {
    case 'zsh':
      return [
        posixLauncher(launcher, options.name),
        zshFunction(options.name),
        options.completions ? zshCompletions(options.name) : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    case 'bash':
      return [
        posixLauncher(launcher, options.name),
        bashFunction(options.name),
        options.completions ? bashCompletions(options.name) : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    case 'fish':
      return [
        fishLauncher(launcher, options.name),
        fishFunction(options.name),
        options.completions ? fishCompletions(options.name) : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    case 'powershell':
      return [
        powershellFunction(options.name),
        options.completions ? powershellCompletions(options.name) : '',
      ]
        .filter(Boolean)
        .join('\n\n')
  }
}

interface Launcher {
  node: string
  cli: string
}

/**
 * The node binary and CLI script running `shell-init` right now.
 *
 * Resolving `grove` through PATH reaches node through whatever the current
 * directory's version manager says. A mise or asdf shim reads the repo's tool
 * config before it starts node, so grove fails in any repo whose config is
 * untrusted, broken, or names a node that isn't installed. Calling these
 * absolute paths keeps grove independent of the directory it runs in.
 */
function currentLauncher(): Launcher | null {
  const script = process.argv[1]
  if (!script) return null
  try {
    const cli = realpathSync(script)
    // Under a test runner or a TypeScript loader argv[1] is not grove itself.
    if (!/\.m?js$/.test(cli)) return null
    return { node: process.execPath, cli }
  } catch {
    return null
  }
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function fishQuote(value: string): string {
  return `'${value.replace(/[\\']/g, '\\$&')}'`
}

/**
 * `__grove` runs the pinned node and script, falling back to `grove` on PATH
 * once either is gone, such as after the node version is uninstalled or grove
 * is upgraded. A new shell picks up the new paths.
 */
function posixLauncher(launcher: Launcher | null, name: string): string {
  const groveFunction = name === 'grove' ? '' : `\n\ngrove() {\n  __grove "$@"\n}`
  if (!launcher) {
    return `# grove launcher\n__grove() {\n  command grove "$@"\n}${groveFunction}`
  }
  return `# grove launcher: the node and script grove was installed with, so the
# current directory's version manager config cannot break it.
__grove_node=${posixQuote(launcher.node)}
__grove_cli=${posixQuote(launcher.cli)}
__grove() {
  if [[ -x "$__grove_node" && -f "$__grove_cli" ]]; then
    "$__grove_node" "$__grove_cli" "$@"
  else
    command grove "$@"
  fi
}${groveFunction}`
}

function fishLauncher(launcher: Launcher | null, name: string): string {
  const groveFunction =
    name === 'grove' ? '' : `\n\nfunction grove --wraps __grove\n    __grove $argv\nend`
  if (!launcher) {
    return `# grove launcher\nfunction __grove\n    command grove $argv\nend${groveFunction}`
  }
  return `# grove launcher: the node and script grove was installed with, so the
# current directory's version manager config cannot break it.
set -g __grove_node ${fishQuote(launcher.node)}
set -g __grove_cli ${fishQuote(launcher.cli)}
function __grove
    if test -x "$__grove_node"; and test -f "$__grove_cli"
        $__grove_node $__grove_cli $argv
    else
        command grove $argv
    end
end${groveFunction}`
}

/** Commands offered at the top level, with descriptions for the picker. */
const COMMANDS: [string, string][] = [
  ['new', 'Create a new worktree for a task'],
  ['checkout', 'Check out an existing branch into a worktree'],
  ['list', 'List worktrees for a repo'],
  ['pick', 'Select a worktree and cd into it'],
  ['sync', 'Fetch and fast-forward a repo main checkout'],
  ['cleanup', 'Remove finished worktrees'],
  ['port', 'Look up and generate worktree ports'],
  ['clone', 'Clone a repo and register it'],
  ['import', 'Adopt an existing local repo'],
  ['create', 'Create a new repo and register it'],
  ['repos', 'List registered repos'],
  ['profile', 'Manage clone profiles'],
  ['skills', 'Install agent skills'],
  ['setup', 'Configure grove'],
  ['shell-init', 'Print shell integration'],
]

/** Commands whose first argument is a repo name. */
const REPO_COMMANDS = [
  'new',
  'checkout',
  'co',
  'list',
  'ls',
  'pick',
  'cd',
  'sync',
  'pull',
  'cleanup',
  'rm',
]

/**
 * The wrapper captures stdout only. Human-readable output goes to stderr and
 * flows through untouched, so prompts and spinners still render correctly.
 */
function zshFunction(name: string): string {
  return `# grove shell integration
${name}() {
  local __grove_out __grove_status
  __grove_out="$(GROVE_SHELL_INTEGRATION=1 __grove "$@")"
  __grove_status=$?
  if (( __grove_status != 0 )); then
    [[ -n "$__grove_out" ]] && print -r -- "$__grove_out"
    return $__grove_status
  fi
  case "$__grove_out" in
    ${CD_SENTINEL}*)
      builtin cd -- "\${__grove_out#${CD_SENTINEL}}" || return 1
      ;;
    "")
      ;;
    *)
      print -r -- "$__grove_out"
      ;;
  esac
}`
}

/**
 * zsh completion. Repo names, worktrees, branches, and profiles are fetched
 * from the binary on demand so they always reflect the current registry.
 */
function zshCompletions(name: string): string {
  const commandLines = COMMANDS.map(([cmd, desc]) => `    '${cmd}:${desc}'`).join('\n')
  const repoCase = REPO_COMMANDS.join('|')

  return `# grove completions
_grove_describe_from() {
  local tag="$1" what="$2" repo="$3"
  local out
  local -i code
  # __complete itself always exits 0, so a failure here is grove not starting.
  out="$(__grove __complete "$what" "$repo" 2>&1)"
  code=$?
  if (( code != 0 )); then
    local -a reason
    reason=("\${(@f)out}")
    _message -r "grove completion failed (exit $code): \${reason[1]:-no output}"
    return 1
  fi
  local -a items
  local line
  for line in "\${(@f)out}"; do
    # Each line is "value<TAB>description"; _describe wants "value:description".
    [[ "$line" == *$'\\t'* ]] || continue
    items+=("\${line%%$'\\t'*}:\${line#*$'\\t'}")
  done
  (( \${#items} )) && _describe -t "$tag" "$tag" items
}

_${name}() {
  local -a commands
  commands=(
${commandLines}
  )

  local curcontext="$curcontext" state line
  typeset -A opt_args

  _arguments -C \\
    '--json[emit machine-readable JSON]' \\
    '--no-interactive[never prompt]' \\
    '1: :->command' \\
    '*:: :->args'

  case $state in
    command)
      _describe -t commands 'grove command' commands
      ;;
    args)
      case $words[1] in
        ${repoCase})
          if (( CURRENT == 2 )); then
            _grove_describe_from repos repos
          elif (( CURRENT == 3 )); then
            case $words[1] in
              checkout|co)
                _grove_describe_from branches branches "$words[2]"
                ;;
              pick|cd|cleanup|rm)
                _grove_describe_from worktrees worktrees "$words[2]"
                ;;
              new)
                _message 'title'
                ;;
            esac
          else
            case $words[1] in
              new)
                _arguments \\
                  '--title[title for the worktree]:title:' \\
                  '--issue[issue key from a configured task tracker]:key:' \\
                  '--no-issue[skip the issue prompt]' \\
                  '--jira[Jira issue key]:key:' \\
                  '--on[stack on an existing branch or worktree]:parent:{_grove_describe_from worktrees worktrees "$words[2]"}' \\
                  '--base[explicit base ref]:ref:' \\
                  '--branch[override branch name]:branch:' \\
                  '--dir[override directory name]:dir:' \\
                  '--no-fetch[skip fetching origin]' \\
                  '--setup[run trusted repo setup commands]' \\
                  '--no-setup[skip repo setup commands]' \\
                  '(-y --yes)'{-y,--yes}'[skip confirmation]'
                ;;
              cleanup|rm)
                _arguments \\
                  '--merged[select merged worktrees]' \\
                  '--force[remove even when dirty]' \\
                  '(-y --yes)'{-y,--yes}'[skip confirmation]' \\
                  '--delete-branch[also delete the local branch]' \\
                  '--delete-remote-branch[also delete the remote branch]' \\
                  '--no-trash[delete permanently]' \\
                  '--dry-run[show what would be removed]' \\
                  '*:worktree:{_grove_describe_from worktrees worktrees "$words[2]"}'
                ;;
            esac
          fi
          ;;
        clone)
          _arguments \\
            '--profile[profile to clone into]:profile:{_grove_describe_from profiles profiles}' \\
            '(-a --alias)'{-a,--alias}'[short alias]:alias:' \\
            '--dir[parent directory]:dir:_files -/'
          ;;
        import)
          _arguments \\
            '1:path:_files -/' \\
            '(-p --profile)'{-p,--profile}'[profile to move the repo into]:profile:{_grove_describe_from profiles profiles}' \\
            '(-a --alias)'{-a,--alias}'[short alias]:alias:' \\
            '--restructure[move the repo into main/]' \\
            '--no-restructure[register the layout as-is]' \\
            '--dir[parent directory to move into]:dir:_files -/'
          ;;
        create)
          _arguments \\
            '(-p --profile)'{-p,--profile}'[profile to create in]:profile:{_grove_describe_from profiles profiles}' \\
            '(-a --alias)'{-a,--alias}'[short alias]:alias:' \\
            '(-b --branch)'{-b,--branch}'[initial branch name]:branch:' \\
            '--github[also create the repo on GitHub]' \\
            '--no-github[skip the GitHub prompt]' \\
            '--visibility[GitHub visibility]:visibility:(private public internal)' \\
            '--owner[GitHub user or org]:owner:' \\
            '--dir[parent directory]:dir:_files -/'
          ;;
        profile)
          if (( CURRENT == 2 )); then
            local -a sub
            sub=('list:List profiles' 'add:Add or update a profile' 'remove:Remove a profile' 'default:Show or set the default profile' 'apply:Write git and Claude config')
            _describe -t subcommands 'profile subcommand' sub
          elif [[ $words[2] == (remove|rm|default) ]]; then
            _grove_describe_from profiles profiles
          fi
          ;;
        skills)
          if (( CURRENT == 2 )); then
            local -a sub
            sub=('install:Install the agent skills' 'list:Show install status' 'uninstall:Remove installed skills')
            _describe -t subcommands 'skills subcommand' sub
          else
            _arguments \\
              '*--target[agent tools to install for]:target:(${AGENT_TARGETS.join(' ')} all)' \\
              '-f[overwrite existing skills]' \\
              '--force[overwrite existing skills]' \\
              '--dry-run[show what would be installed]'
          fi
          ;;
        repos)
          if (( CURRENT == 2 )); then
            local -a sub
            sub=('add:Register an existing repo' 'remove:Unregister a repo')
            _describe -t subcommands 'repos subcommand' sub
          elif [[ $words[2] == (remove|rm) ]]; then
            _grove_describe_from repos repos
          fi
          ;;
        shell-init)
          local -a shells
          shells=('zsh' 'bash' 'fish' 'powershell')
          _describe -t shells 'shell' shells
          ;;
      esac
      ;;
  esac
}

# compdef only exists once compinit has run. Registering unconditionally
# would print "command not found" for anyone sourcing this before their
# completion system is initialised.
if (( $+functions[compdef] )); then
  compdef _${name} ${name}
  compdef _${name} grove
fi`
}

function bashFunction(name: string): string {
  return `# grove shell integration
${name}() {
  local __grove_out __grove_status
  __grove_out="$(GROVE_SHELL_INTEGRATION=1 __grove "$@")"
  __grove_status=$?
  if [ $__grove_status -ne 0 ]; then
    [ -n "$__grove_out" ] && printf '%s\\n' "$__grove_out"
    return $__grove_status
  fi
  case "$__grove_out" in
    ${CD_SENTINEL}*)
      cd -- "\${__grove_out#${CD_SENTINEL}}" || return 1
      ;;
    "")
      ;;
    *)
      printf '%s\\n' "$__grove_out"
      ;;
  esac
}`
}

function bashCompletions(name: string): string {
  const commands = COMMANDS.map(([cmd]) => cmd).join(' ')
  const repoCommands = REPO_COMMANDS.join(' ')

  return `# grove completions
_grove_values() {
  local out code
  # __complete itself always exits 0, so a failure here is grove not starting.
  out="$(__grove __complete "$1" "\${2:-}" 2>&1)"
  code=$?
  if [ $code -ne 0 ]; then
    printf '\\ngrove completion failed (exit %s): %s\\n' "$code" "\${out%%$'\\n'*}" >&2
    return $code
  fi
  # Strip the tab-separated description; bash shows values only.
  printf '%s\\n' "$out" | grep $'\\t' | cut -f1
}

# Fill COMPREPLY with the lines on stdin that start with $1. Not compgen -W:
# it expands its word list, and these words are branch and repo names that
# anyone who can push to origin chooses, so $(...) in one would run. Each is
# escaped too, so accepting the completion doesn't run it either.
_grove_reply() {
  local line
  COMPREPLY=()
  while IFS= read -r line; do
    [[ -n "$line" && "$line" == "$1"* ]] && COMPREPLY+=("$(printf '%q' "$line")")
  done
}

_grove_complete() {
  local cur prev words cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]:-}"
  local cmd="\${COMP_WORDS[1]:-}"
  local repo_commands=" ${repoCommands} "

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )
    return
  fi

  case "$cmd" in
    profile)
      if [ "$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "list add remove default apply" -- "$cur") )
        return
      fi
      ;;
    skills)
      if [ "$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "install list uninstall" -- "$cur") )
        return
      fi
      if [ "$prev" = "--target" ] || [ "$prev" = "-t" ]; then
        COMPREPLY=( $(compgen -W "${AGENT_TARGETS.join(' ')} all" -- "$cur") )
        return
      fi
      COMPREPLY=( $(compgen -W "--target --force --dry-run" -- "$cur") )
      return
      ;;
    repos)
      if [ "$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "add remove" -- "$cur") )
        return
      fi
      ;;
    shell-init)
      COMPREPLY=( $(compgen -W "zsh bash fish powershell" -- "$cur") )
      return
      ;;
  esac

  if [[ "$repo_commands" == *" $cmd "* ]]; then
    if [ "$COMP_CWORD" -eq 2 ]; then
      _grove_reply "$cur" < <(_grove_values repos)
      return
    fi
    if [ "$COMP_CWORD" -eq 3 ]; then
      case "$cmd" in
        checkout|co)
          _grove_reply "$cur" < <(_grove_values branches "\${COMP_WORDS[2]}")
          return
          ;;
        pick|cd|cleanup|rm)
          _grove_reply "$cur" < <(_grove_values worktrees "\${COMP_WORDS[2]}")
          return
          ;;
      esac
    fi
  fi

  COMPREPLY=( $(compgen -W "--json --no-interactive --help" -- "$cur") )
}

complete -F _grove_complete ${name}
complete -F _grove_complete grove`
}

function fishFunction(name: string): string {
  return `# grove shell integration
function ${name} --description 'git worktree manager'
    set -l __grove_out (GROVE_SHELL_INTEGRATION=1 __grove $argv)
    set -l __grove_status $status
    if test $__grove_status -ne 0
        test -n "$__grove_out"; and printf '%s\\n' $__grove_out
        return $__grove_status
    end
    if string match -q '${CD_SENTINEL}*' -- "$__grove_out"
        cd (string replace '${CD_SENTINEL}' '' -- "$__grove_out")
    else if test -n "$__grove_out"
        printf '%s\\n' $__grove_out
    end
end`
}

function fishCompletions(name: string): string {
  const commandCompletions = COMMANDS.map(
    ([cmd, desc]) =>
      `complete -c ${name} -n __fish_use_subcommand -a ${cmd} -d '${desc.replace(/'/g, "\\'")}'`,
  ).join('\n')

  const repoCondition = REPO_COMMANDS.map((cmd) => `__fish_seen_subcommand_from ${cmd}`).join(
    '; or ',
  )

  return `# grove completions
# fish renders "value<TAB>description" natively, so pass the lines through.
function __grove_complete
    # __complete itself always exits 0, so a failure here is grove not starting.
    set -l out (__grove __complete $argv 2>&1)
    set -l code $status
    if test $code -ne 0
        printf '\\ngrove completion failed (exit %s): %s\\n' $code "$out[1]" >&2
        return $code
    end
    string match -re -- \\t $out
end

function __grove_repo_arg
    # The repo is the token right after the subcommand.
    set -l tokens (commandline -opc)
    if test (count $tokens) -ge 3
        echo $tokens[3]
    end
end

${commandCompletions}

# Repo names as the first argument to repo-taking commands.
complete -c ${name} -n '${repoCondition}' -n 'not __fish_seen_subcommand_from (__grove_complete repos | cut -f1)' -a '(__grove_complete repos)'

# Branches for checkout, worktrees for pick/cleanup.
complete -c ${name} -n '__fish_seen_subcommand_from checkout co' -a '(__grove_complete branches (__grove_repo_arg))'
complete -c ${name} -n '__fish_seen_subcommand_from pick cd cleanup rm' -a '(__grove_complete worktrees (__grove_repo_arg))'
complete -c ${name} -n '__fish_seen_subcommand_from clone' -l profile -a '(__grove_complete profiles)' -d 'Profile to clone into'
complete -c ${name} -n '__fish_seen_subcommand_from import create' -l profile -a '(__grove_complete profiles)' -d 'Profile directory to use'
complete -c ${name} -n '__fish_seen_subcommand_from import' -l restructure -d 'Move the repo into main/'
complete -c ${name} -n '__fish_seen_subcommand_from import' -l no-restructure -d 'Register the layout as-is'
complete -c ${name} -n '__fish_seen_subcommand_from create' -l github -d 'Also create the repo on GitHub'
complete -c ${name} -n '__fish_seen_subcommand_from create' -l no-github -d 'Skip the GitHub prompt'
complete -c ${name} -n '__fish_seen_subcommand_from create' -l visibility -a 'private public internal' -d 'GitHub visibility'

complete -c ${name} -n '__fish_seen_subcommand_from profile' -a 'list add remove default apply'
complete -c ${name} -n '__fish_seen_subcommand_from skills' -a 'install list uninstall'
complete -c ${name} -n '__fish_seen_subcommand_from skills' -l target -a '${AGENT_TARGETS.join(' ')} all' -d 'Agent tool to install for'
complete -c ${name} -n '__fish_seen_subcommand_from repos' -a 'add remove'
complete -c ${name} -n '__fish_seen_subcommand_from shell-init' -a 'zsh bash fish powershell'

complete -c ${name} -l json -d 'Emit machine-readable JSON'
complete -c ${name} -l no-interactive -d 'Never prompt'`
}

function powershellFunction(name: string): string {
  return `# grove shell integration
function ${name} {
    $env:GROVE_SHELL_INTEGRATION = '1'
    try {
        $out = & grove @args
        $code = $LASTEXITCODE
    } finally {
        Remove-Item Env:\\GROVE_SHELL_INTEGRATION -ErrorAction SilentlyContinue
    }
    if ($code -ne 0) {
        if ($out) { Write-Output $out }
        return
    }
    if ($out -is [array]) { $out = $out -join "\`n" }
    if ($out -and $out.StartsWith('${CD_SENTINEL}')) {
        Set-Location $out.Substring(${CD_SENTINEL.length})
    } elseif ($out) {
        Write-Output $out
    }
}`
}

function powershellCompletions(name: string): string {
  const commands = COMMANDS.map(([cmd, desc]) => `        @{ N = '${cmd}'; D = '${desc}' }`).join(
    '\n',
  )
  const repoCommands = REPO_COMMANDS.map((cmd) => `'${cmd}'`).join(', ')

  return `# grove completions
Register-ArgumentCompleter -Native -CommandName ${name}, grove -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commands = @(
${commands}
    )
    $repoCommands = @(${repoCommands})
    $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
    $position = $tokens.Count
    if ($wordToComplete) { $position-- }

    # PowerShell inserts a completion as typed, and branch and repo names are
    # chosen by anyone who can push to origin, so one holding $(...) would run
    # with the line. Single quotes keep it literal; PowerShell also ends a
    # single-quoted string on the typographic quotes, so those are doubled too.
    function New-Result($value, $desc) {
        $text = if ($value -match '[^\\w./:\\\\-]') {
            "'" + ($value -replace "['‘’‚‛]", '$0$0') + "'"
        } else { $value }
        [System.Management.Automation.CompletionResult]::new(
            $text, $value, 'ParameterValue', $desc)
    }

    function Get-GroveCandidates($what, $repo) {
        $raw = & grove __complete $what $repo 2>$null
        if (-not $raw) { return @() }
        $raw | ForEach-Object {
            $parts = $_ -split "\`t", 2
            New-Result $parts[0] ($parts[1] ?? $parts[0])
        }
    }

    if ($position -le 1) {
        return $commands |
            Where-Object { $_.N -like "$wordToComplete*" } |
            ForEach-Object { New-Result $_.N $_.D }
    }

    $sub = $tokens[1]
    if ($position -eq 2 -and $repoCommands -contains $sub) {
        return Get-GroveCandidates 'repos' $null |
            Where-Object { $_.ListItemText -like "$wordToComplete*" }
    }
    if ($position -eq 3 -and $repoCommands -contains $sub) {
        $repo = $tokens[2]
        $what = if ($sub -in 'checkout', 'co') { 'branches' } else { 'worktrees' }
        return Get-GroveCandidates $what $repo |
            Where-Object { $_.ListItemText -like "$wordToComplete*" }
    }
    if ($position -eq 2 -and $sub -eq 'profile') {
        return @('list', 'add', 'remove', 'default', 'apply') |
            Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { New-Result $_ 'profile subcommand' }
    }
    @()
}`
}
