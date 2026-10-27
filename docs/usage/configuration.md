# Configuration

## `grove setup`

```bash
grove setup
```

In a terminal this opens a menu of every setting with its current value.
Pick one to change it, come back to the menu, and choose **Save and exit**
when done. Ctrl-C inside a setting returns to the menu; Ctrl-C at the menu
discards your edits.

Flags set values without the menu, touching only what they name:

```bash
grove setup --branch-prefix me/ --task-trackers github --no-trash
```

`grove setup --show` prints the current config.

## Config file

`grove setup` writes `~/.config/grove/config.json`:

| Key | Meaning |
| --- | --- |
| `branchPrefix` | Prefix for generated branches (default `<user>/`) |
| `defaultCodeDir` | Clone directory used when no profile matches |
| `profiles` | Named base directories, each with an optional description and rules. See [Profiles](profiles.md) |
| `defaultProfile` | Profile used when `--profile` is not given |
| `reposFile` | Repo registry location (default `~/.wt_repos`). See [Repositories](repos.md#the-registry-and-aliases) |
| `useTrash` | Trash removed worktrees instead of deleting (`--trash` / `--no-trash`) |
| `taskTrackers` | Trackers whose issue keys `grove new` detects and prompts for: any of `jira`, `linear`, `github`, in detection order (default `["jira"]`; `[]` for none). Set with `grove setup --task-trackers github,jira` |
| `managedClaudePermissions` | Internal ownership record used to revoke only Claude grants grove added |

## Environment variables

| Variable | Effect |
| --- | --- |
| `GROVE_BRANCH_PREFIX` | Overrides `branchPrefix` |
| `GROVE_DEFAULT_CODE_DIR` | Overrides `defaultCodeDir` |
| `GROVE_REPOS_FILE` | Overrides `reposFile` |
| `GROVE_TRASH_DIR` | Use this directory instead of the system trash (useful on Linux without a freedesktop trash helper) |
| `GROVE_SYSTEM_TRASH=0` | Skip the system trash and always use `.grove-trash/` |
| `GROVE_NO_GITHUB=1` | Never shell out to `gh` |

The older `WT_*` names are still honoured.

## Shell integration

```bash
# ~/.zshrc — after your compinit
eval "$(grove shell-init zsh)"
```

That defines a `wt` function which changes directory and completes repo names,
worktrees, branches, and profiles on <kbd>Tab</kbd>. Bash, fish, and PowerShell
are also supported — pass the shell name, or omit it to auto-detect.

A child process cannot change its parent shell's working directory, so `grove`
prints a sentinel line and the generated `wt` function performs the `cd`. This
is the same approach `zoxide` and `direnv` use.

Completions are registered for both `wt` and `grove`. Place the `eval` after
`compinit` in your `.zshrc`; if `compinit` has not run, the function is still
defined and completion registration is skipped silently.

Everything works without the wrapper too — commands print the path instead of
jumping, so `cd "$(grove pick myrepo)"` remains available.
