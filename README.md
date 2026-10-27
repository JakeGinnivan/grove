# grove

A git worktree manager. Clone once, then work on several branches at the same
time in separate directories — no stashing, no branch switching.

```
~/_code/my-service/
  main/                      # primary checkout — kept clean, used as a reference
  260810-fix-login/          # a task worktree
  260811-add-metrics-ABC-1/  # another, tagged with a ticket key
```

Every directory is a real checkout backed by one clone, so switching tasks is
`cd`. Works on macOS, Linux and Windows, and every command can run
non-interactively so coding agents can drive it.

## Get started

**1. Install** (Node 24+):

```bash
npm install -g @jakeginnivan/grove
```

**2. Add the shell integration**, which gives you the `wt` shortcut with
<kbd>Tab</kbd> completion and lets it change your directory:

```bash
# ~/.zshrc — after compinit
eval "$(grove shell-init zsh)"
```

Bash, fish and PowerShell work too: pass `bash`, `fish` or `pwsh`, or leave the
shell name off to auto-detect.

**3. Configure** your branch prefix, clone directory and task trackers:

```bash
grove setup
```

**4. Install the agent skills** (optional, if you use Claude Code, Codex,
Copilot CLI, Gemini CLI, Cursor or opencode):

```bash
grove skills install
```

This teaches your agents to find your repos, create a worktree per task and
clean up after themselves. See [Agent support](docs/usage/agents.md).

## Quick tour

```bash
wt clone git@github.com:owner/my-service.git   # → ~/_code/my-service/main
wt new my-service "fix flaky login test"       # new branch + worktree, cd'd into it
wt pick my-service                             # jump between worktrees
wt checkout my-service colleague/their-branch  # review someone's branch
wt sync                                        # fast-forward every main checkout
wt cleanup my-service --merged                 # remove worktrees that have merged
```

`wt` and `grove` are the same commands; `wt` can also `cd` you. Already have a
clone? `wt import ~/src/my-service` adopts it.

## Documentation

**Using grove**

- [Repositories](docs/usage/repos.md) — clone, import or create repos, aliases
- [Worktrees](docs/usage/worktrees.md) — start tasks, ticket keys, check out
  branches, stack work, move around, sync, clean up
- [Profiles](docs/usage/profiles.md) — group repos by directory with per-profile
  git config and rules for agents
- [Agent support](docs/usage/agents.md) — skills, Claude Code auto mode, `--json`
  output and error codes
- [Per-repo `worktree.json`](docs/usage/worktree-json.md) — setup commands and
  per-worktree ports
- [Configuration](docs/usage/configuration.md) — `grove setup`, config keys,
  environment variables, shell integration

**Working on grove**

- [Development and releasing](docs/development/contributing.md)
- [Port offset design](docs/development/port-offset-plan.md) and
  [port conventions research](docs/development/port-conventions.md)

## License

MIT
