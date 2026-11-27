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
grove shell-init --install
```

That adds a line to your shell's startup file which defines a `wt` function.
The function changes directory and completes repo names, worktrees, branches
and profiles on <kbd>Tab</kbd>. The **Shell integration** entry in
`grove setup` does the same.

The shell is detected from `$SHELL` (PowerShell on Windows); pass one to
override it, as in `grove shell-init bash --install`. Install does nothing if
any of the files below already mention `grove shell-init`, so running it twice
is safe and a line you added yourself is respected.

| Shell | Written to | Line |
| --- | --- | --- |
| zsh | `$ZDOTDIR/.zshrc` (or `~/.zshrc`) | `eval "$(grove shell-init zsh)"` |
| bash | `~/.bash_profile` on macOS, `~/.bashrc` elsewhere (the other is also checked) | `eval "$(grove shell-init bash)"` |
| fish | `~/.config/fish/conf.d/grove.fish` (`config.fish` is also checked) | `grove shell-init fish \| source` |
| PowerShell 7 | `$PROFILE` | `Invoke-Expression (& grove shell-init powershell \| Out-String)` |

The line is appended to the end of the file, which in zsh puts it after
`compinit`. `--name <name>` and `--no-completions` are carried into the line.
To add it by hand instead, print the script with `grove shell-init <shell>`
and put the line from the table in your startup file yourself.

A child process cannot change its parent shell's working directory, so `grove`
prints a sentinel line and the generated `wt` function performs the `cd`. This
is the same approach `zoxide` and `direnv` use.

Completions are registered for both `wt` and `grove`. Place the `eval` after
`compinit` in your `.zshrc`; if `compinit` has not run, the function is still
defined and completion registration is skipped silently.

In zsh, bash and fish, the script records the absolute paths of the node binary
and the grove script that generated it, and `wt`, its completions and a `grove`
function call those paths directly. A version manager's `node` shim (mise,
asdf) reads the current directory's tool config before it starts node, so
calling `grove` through `PATH` fails in any repo whose config is untrusted or
names a node that is not installed. If either recorded path disappears, as
after removing that node version or upgrading grove, the functions fall back to
`grove` on `PATH`, and a new shell records the new paths. PowerShell still
calls `grove` on `PATH`.

If `grove` cannot start while completing, the completion shows
`grove completion failed` with the first line of the error instead of offering
nothing.

Everything works without the wrapper too — commands print the path instead of
jumping, so `cd "$(grove pick myrepo)"` remains available.

## Upgrading grove

```bash
grove upgrade           # install the latest release
grove upgrade --check   # only say whether there is one
```

grove asks the npm registry for its latest version, honouring
`npm_config_registry`, and does nothing if it already has it. Otherwise it
works out which tool installed it from where its own files live, and runs
that tool:

| Installed with | `grove upgrade` runs |
| --- | --- |
| npm | `npm install --global --prefix <the prefix grove is in> @jakeginnivan/grove@latest` |
| pnpm | `pnpm add --global @jakeginnivan/grove@latest` |
| Yarn classic | `yarn global add @jakeginnivan/grove@latest` |
| mise | `mise upgrade npm:@jakeginnivan/grove` |

npm gets the prefix grove is in, so a version manager that picks node per
directory can't send the upgrade to a different node. mise stays within the
version your mise config asks for, so a pinned grove stays pinned.

A grove run from a checkout, through npx, or as a project dependency is not
a global install. `grove upgrade` stops with the commands above rather than
guess.

After upgrading, run `grove skills install` to update the agent skills (see
[Agent support](agents.md#after-upgrading-grove)).
