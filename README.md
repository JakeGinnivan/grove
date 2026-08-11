# grove

A git worktree manager. Clone once, then work on several branches at the same
time in separate directories — no stashing, no branch switching.

The binary is `grove`; the shell integration gives you `wt` as the everyday
shortcut, with tab completion and directory-changing built in.

Cross-platform (macOS, Linux, Windows), with first-class non-interactive
commands so coding agents can drive it.

## Why worktrees

`grove` gives each repo this layout:

```
~/_code/my-service/
  main/                      # primary checkout — shared reference, read-only
  260810-fix-login/          # a task worktree
  260811-add-metrics-ABC-1/  # another, tagged with a Jira key
```

Every directory is a real checkout backed by one clone, so switching tasks is
`cd`, not `git stash`.

## Install

```bash
npm install -g @jakeginnivan/grove
```

Then add the shell integration:

```bash
# ~/.zshrc — after your compinit
eval "$(grove shell-init zsh)"
```

That defines a `wt` function which changes directory and completes repo names,
worktrees, branches, and profiles on <kbd>Tab</kbd>. Bash, fish, and PowerShell
are also supported — pass the shell name, or omit it to auto-detect.

<details>
<summary>Why <code>wt</code> is a shell function</summary>

A child process cannot change its parent shell's working directory. `grove`
prints a sentinel line and the generated `wt` function performs the `cd`. This
is the same approach `zoxide` and `direnv` use.

Completions are registered for both `wt` and `grove`. Place the `eval` after
`compinit` in your `.zshrc`; if `compinit` has not run, the function is still
defined and completion registration is skipped silently.

Everything works without the wrapper too — commands print the path instead of
jumping, so `cd "$(grove pick myrepo)"` remains available.

</details>

Configure paths and your branch prefix:

```bash
grove setup
```

## Usage

Examples use `wt` (the shortcut); `grove` works identically everywhere.

### Clone and register a repo

```bash
wt clone git@github.com:owner/my-service.git
```

Clones into `<code-dir>/my-service/main` and registers it. Existing clones can
be adopted with `wt repos add <path>`.

### Start work on something

```bash
wt new my-service "fix flaky login test"
```

Creates the branch `you/fix-flaky-login-test` from the latest `origin/HEAD`,
puts it in `260810-fix-flaky-login-test/`, and cd's you into it.

With a ticket:

```bash
wt new my-service "fix login" --jira ABC-123
#   branch:   you/ABC-123-fix-login
#   worktree: 260810-fix-login-ABC-123
```

A key already present in the title is detected automatically.

### Check out an existing branch

```bash
wt checkout my-service colleague/their-branch
```

Resolves a local branch first, then `origin/<branch>` (creating a local
tracking branch). Omit the branch to pick interactively — or press
<kbd>Tab</kbd> to see the available branches. Pass `--create` for a branch that
does not exist yet.

### Stack a branch on another

By default a new worktree branches off the latest main. To build on work that
is not merged yet:

```bash
wt new my-service "address feedback" --on 260810-fix-flaky-login-test
```

`--on` accepts a worktree directory, a worktree path, or a branch name. The
parent is recorded in git config (`branch.<name>.wt-parent`), so `wt list`
shows the stack:

```
260810-fix-flaky-login-test  you/fix-flaky-login-test
260810-address-feedback      you/address-feedback   on you/fix-flaky-login-test
```

Stacked branches have no upstream until you push; use `git push -u origin HEAD`.

### Move around

```bash
wt pick my-service            # interactive picker
wt pick my-service fix-login  # jump by substring
wt pick my-service --main     # jump to the main checkout
```

### Keep main current

```bash
wt sync my-service   # fetch + fast-forward the main checkout
wt sync              # every registered repo
```

`sync` only fast-forwards when the main checkout is clean and on the default
branch. Otherwise it reports why it skipped and changes nothing.

### Clean up

```bash
wt cleanup my-service                    # interactive multi-select
wt cleanup my-service --merged --yes     # everything already merged
wt cleanup my-service 260810-old --yes   # a specific worktree
wt cleanup self                          # the worktree you are standing in
```

Worktrees with uncommitted changes or unpushed commits are **skipped** unless
you pass `--force`, and `--yes` alone will not override that. Removed
directories go to the system trash where available. `--dry-run` shows what
would happen.

## Profiles

A profile is a base directory that repositories are grouped under. Typical
setup: work code in one directory, alongside open-source dependencies you read
but do not modify.

```bash
grove profile add work ~/_code/work \
  --description "Internal work code" \
  --rule "Never copy code from other profiles into this one (licensing)."

grove profile add oss ~/_code/oss \
  --description "Open-source dependencies, for reference" \
  --rule "Reference only. Do not copy source into work repositories."

grove profile default work
```

A profile decides where `grove clone` puts a repo, and carries `--rule`
statements that the agent skills surface. Adding one configures it
immediately — there is no second step. Each write goes inside a marked block
grove owns, so your own settings survive:

| File | What it gets |
| --- | --- |
| `<profile>/.gitconfig` | A managed header; add your own per-profile git settings below it |
| `~/.gitconfig` | `includeIf gitdir:` stanzas pointing at each profile config |
| `~/.claude/settings.json` | `additionalDirectories` + `Read(<dir>/**)` so agents can read your repos |

The per-profile `.gitconfig` is wired up but intentionally empty. Anything you
add below the managed block applies to every repo in that directory — a work
email, a signing key, or `pushInsteadOf` rules if you want to block a host:

```ini
# ~/_code/work/.gitconfig, below the grove-managed block
[url "blocked://"]
	pushInsteadOf = https://github.com/
```

Because these files live outside the project, an interactive run lists them
and asks once before writing. Pass `-y` to skip the prompt, or `--no-apply`
to record the profile without touching anything.

Removing a profile cleans up after itself: its `includeIf` stanza and grove's
managed block both go, and hand-written config is left alone.

`grove profile apply` re-syncs everything. You need it only after editing
`~/.config/grove/config.json` by hand, or when setting up a new machine from
an existing config. It is idempotent; `--dry-run` previews the changes.

Once profiles exist, `wt clone` picks one: `--profile` wins, then the default
profile, then a prompt when several exist and none is the default.
Non-interactively without a default, pass `--profile <name>`.

```bash
wt clone git@github.com:facebook/react.git --profile oss
```

Set or inspect the default at any time:

```bash
grove profile default        # show the current default
grove profile default work   # set it
grove profile default --clear
```

Cloning a URL into a profile that blocks its host is refused outright.

Rules are surfaced to agents through `grove profile list --json` and the
installed skills, so an assistant working in your `work` tree knows it may
read `oss` code but not copy it across.

## Agent support

### Install the skills

```bash
grove skills install
```

This detects the agent tools installed on your machine and asks which of them
to install for, with all pre-selected:

```
Which tools should grove install skills for?

  ◉ Claude Code          ~/.claude/skills
  ◉ Codex CLI            ~/.codex/skills
  ◉ GitHub Copilot CLI   ~/.copilot/skills
  ◉ Gemini CLI           ~/.gemini/skills
```

Two skills are installed:

- **wt-repos** — discovering cloned repos and their paths, which profile each
  belongs to and what rules apply, and running `grove sync` before reading
  code so the agent is not reasoning about a stale checkout.
- **wt-worktree** — creating worktrees for tasks, checking out branches,
  stacking work, and cleaning up safely.

Each tool reads skills from its own directory, so grove writes a copy per
tool. Supported: `claude`, `codex`, `copilot`, `cursor`, `gemini`, and
`opencode`. Skip the prompt with `--target`:

```bash
grove skills install --target claude codex   # named tools
grove skills install --target all            # every known tool
grove skills install --target ~/somewhere    # an explicit directory
```

Without a TTY (`--json`, CI, or an agent), install goes to every detected
tool without prompting. `grove skills list` shows where the skills are
installed and which tools were detected; `grove skills uninstall` removes
them.

### Non-interactive commands

Every command runs unattended. `--json` prints a machine-readable result and
implies `--no-interactive`:

```bash
grove repos --json
grove list my-service --json
grove new my-service --title "fix login" --json
grove checkout my-service some-branch --json
grove sync my-service --json
grove profile list --json
grove cleanup my-service 260810-old --yes --json
```

Human-readable output goes to stderr, so stdout stays a clean JSON stream.

When a required value is missing, the command exits 2 rather than hanging on a
prompt:

```json
{
  "ok": false,
  "error": {
    "code": "needs_input",
    "message": "A title is required in non-interactive mode.",
    "hint": "Pass --title, or run in an interactive terminal."
  }
}
```

`error.code` is stable and safe to branch on. Notable codes: `needs_input`,
`unknown_repo`, `unknown_profile`, `branch_exists`, `branch_in_use`,
`branch_not_found`, `worktree_exists`, `unknown_stack_parent`,
`no_matching_worktree`, `ambiguous_worktree`, `alias_conflicts_with_repo`.

Prompts are also skipped automatically when stdin is not a TTY.

## Per-repo setup commands

A repo can declare commands to run in each new worktree, via `worktree.json`
or `.cursor/worktrees.json` committed at the root of the repo itself (the
`main/` checkout, not the parent directory holding the worktrees):

```json
{
  "setup-worktree": ["pnpm install", "cp $ROOT_WORKTREE_PATH/.env .env"]
}
```

Commands run inside the new worktree with `ROOT_WORKTREE_PATH` pointing at the
main checkout. A failing command warns and continues rather than aborting the
worktree. Skip them with `--no-setup`.

## Configuration

`grove setup` writes `~/.config/grove/config.json`:

| Key | Meaning |
| --- | --- |
| `branchPrefix` | Prefix for generated branches (default `<user>/`) |
| `defaultCodeDir` | Clone directory used when no profile matches |
| `profiles` | Named base directories, each with an optional description and rules |
| `defaultProfile` | Profile used when `--profile` is not given |
| `reposFile` | Repo registry location (default `~/.wt_repos`) |
| `useTrash` | Trash removed worktrees instead of deleting |

`GROVE_BRANCH_PREFIX`, `GROVE_DEFAULT_CODE_DIR`, `GROVE_REPOS_FILE`, and
`GROVE_TRASH_DIR` override the file. The older `WT_*` names are still honoured.

The registry format is shared with the original zsh helper, so an existing
`~/.wt_repos` keeps working:

```
my-service /Users/you/_code/my-service
ms my-service
```

The second line makes `ms` an alias.

## Development

```bash
pnpm install
pnpm build       # bundle to dist/
pnpm test        # unit + integration tests against real git repos
pnpm typecheck
```

Built with TypeScript 7. Integration tests run the built bundle against
throwaway git repos with a redirected `HOME`, so they exercise what ships
without touching your real configuration.

CI runs the suite on Node 20 and 24 across Linux, macOS, and Windows.

## Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets).
When you change something users can observe, describe it:

```bash
pnpm changeset
```

Pick the bump and write a sentence for the release notes. Commit the generated
file with your change; CI fails a PR that touches `src/` without one.

On merge to `main`, CI opens a **Version Packages** PR that applies the pending
changesets — bumping the version and folding them into `CHANGELOG.md`. Merging
that PR publishes to npm. The version PR is the release gate: nothing ships
until you merge it.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
over OIDC, so there is no npm token stored in GitHub — nothing to leak, and
every release carries a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements/)
linking it to the commit and workflow run that built it. Verify one with:

```bash
npm audit signatures
```

## License

MIT
