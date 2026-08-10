import { Command } from 'commander'
import { CD_SENTINEL } from '../core/output.js'
import { WtError } from '../core/errors.js'

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
    .action((shellArg: string | undefined, options: ShellInitOptions) => {
      const shell = shellArg ?? detectShell()
      process.stdout.write(`${scriptFor(shell, options)}\n`)
    })
}

interface ShellInitOptions {
  name: string
  completions: boolean
}

function detectShell(): string {
  if (process.platform === 'win32') return 'powershell'
  const shellPath = process.env['SHELL'] ?? ''
  if (shellPath.includes('fish')) return 'fish'
  if (shellPath.includes('bash')) return 'bash'
  return 'zsh'
}

function scriptFor(shell: string, options: ShellInitOptions): string {
  switch (shell) {
    case 'zsh':
      return [zshFunction(options.name), options.completions ? zshCompletions(options.name) : '']
        .filter(Boolean)
        .join('\n\n')
    case 'bash':
      return [bashFunction(options.name), options.completions ? bashCompletions(options.name) : '']
        .filter(Boolean)
        .join('\n\n')
    case 'fish':
      return [fishFunction(options.name), options.completions ? fishCompletions(options.name) : '']
        .filter(Boolean)
        .join('\n\n')
    case 'powershell':
    case 'pwsh':
      return [
        powershellFunction(options.name),
        options.completions ? powershellCompletions(options.name) : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    default:
      throw new WtError(`Unsupported shell: ${shell}`, {
        code: 'unsupported_shell',
        hint: 'Supported: zsh, bash, fish, powershell.',
      })
  }
}

/** Commands offered at the top level, with descriptions for the picker. */
const COMMANDS: [string, string][] = [
  ['new', 'Create a new worktree for a task'],
  ['checkout', 'Check out an existing branch into a worktree'],
  ['list', 'List worktrees for a repo'],
  ['pick', 'Select a worktree and cd into it'],
  ['sync', 'Fetch and fast-forward a repo main checkout'],
  ['cleanup', 'Remove finished worktrees'],
  ['clone', 'Clone a repo and register it'],
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
  __grove_out="$(GROVE_SHELL_INTEGRATION=1 command grove "$@")"
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
_grove_candidates() {
  local what="$1" repo="$2"
  local -a out
  out=("\${(@f)$(command grove __complete "$what" "$repo" 2>/dev/null)}")
  print -r -- "\${out[@]}"
}

_grove_describe_from() {
  local tag="$1" what="$2" repo="$3"
  local -a lines items
  lines=("\${(@f)$(command grove __complete "$what" "$repo" 2>/dev/null)}")
  items=()
  local line
  for line in "\${lines[@]}"; do
    [[ -z "$line" ]] && continue
    # Each line is "value<TAB>description"; _describe wants "value:description".
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
                  '--jira[Jira issue key]:key:' \\
                  '--on[stack on an existing branch or worktree]:parent:{_grove_describe_from worktrees worktrees "$words[2]"}' \\
                  '--base[explicit base ref]:ref:' \\
                  '--branch[override branch name]:branch:' \\
                  '--dir[override directory name]:dir:' \\
                  '--no-fetch[skip fetching origin]' \\
                  '--no-setup[skip repo setup commands]' \\
                  '(-y --yes)'{-y,--yes}'[skip confirmation]'
                ;;
              cleanup|rm)
                _arguments \\
                  '--merged[select merged worktrees]' \\
                  '--force[remove even when dirty]' \\
                  '(-y --yes)'{-y,--yes}'[skip confirmation]' \\
                  '--delete-branch[also delete the local branch]' \\
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
  __grove_out="$(GROVE_SHELL_INTEGRATION=1 command grove "$@")"
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
  # Strip the tab-separated description; bash shows values only.
  command grove __complete "$1" "\${2:-}" 2>/dev/null | cut -f1
}

_grove_complete() {
  local cur prev words cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
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
      COMPREPLY=( $(compgen -W "$(_grove_values repos)" -- "$cur") )
      return
    fi
    if [ "$COMP_CWORD" -eq 3 ]; then
      case "$cmd" in
        checkout|co)
          COMPREPLY=( $(compgen -W "$(_grove_values branches "\${COMP_WORDS[2]}")" -- "$cur") )
          return
          ;;
        pick|cd|cleanup|rm)
          COMPREPLY=( $(compgen -W "$(_grove_values worktrees "\${COMP_WORDS[2]}")" -- "$cur") )
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
    set -l __grove_out (GROVE_SHELL_INTEGRATION=1 command grove $argv)
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
    command grove __complete $argv 2>/dev/null
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

complete -c ${name} -n '__fish_seen_subcommand_from profile' -a 'list add remove default apply'
complete -c ${name} -n '__fish_seen_subcommand_from skills' -a 'install list uninstall'
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

    function New-Result($value, $desc) {
        [System.Management.Automation.CompletionResult]::new(
            $value, $value, 'ParameterValue', $desc)
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
            Where-Object { $_.CompletionText -like "$wordToComplete*" }
    }
    if ($position -eq 3 -and $repoCommands -contains $sub) {
        $repo = $tokens[2]
        $what = if ($sub -in 'checkout', 'co') { 'branches' } else { 'worktrees' }
        return Get-GroveCandidates $what $repo |
            Where-Object { $_.CompletionText -like "$wordToComplete*" }
    }
    if ($position -eq 2 -and $sub -eq 'profile') {
        return @('list', 'add', 'remove', 'default', 'apply') |
            Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { New-Result $_ 'profile subcommand' }
    }
    @()
}`
}
