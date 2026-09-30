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

Clones into `<code-dir>/my-service/main` and registers it.

### Adopt an existing local repo

```bash
wt import ~/src/my-service
```

Grove keeps the primary checkout in `<repo>/main` so sibling directories can be
worktrees. When the repo is a plain clone instead, `import` says so and offers
to move it into a `main/` subfolder, in place — the repo's own path does not
change, so anything pointing at the folder still resolves:

```
~/src/my-service/        →   ~/src/my-service/main/
```

Pass `--restructure` or `--no-restructure` to decide without being asked
(required under `--json`, since the move touches files). A repo with linked
worktrees is refused rather than broken, and `-p <profile>` / `--dir <path>`
additionally move the repo under a profile directory.

To register a repo without touching its layout at all, pass
`--no-restructure`.

> `wt repos add` is deprecated: it now forwards to `wt import
> --no-restructure` and prints a warning. It will be removed in v1.

### Start a new repo

```bash
wt create my-tool
```

Creates `<code-dir>/my-tool/main`, runs `git init` on branch `main`, and
registers it.

When the [GitHub CLI](https://cli.github.com) is installed and logged in, it
then offers to create the repo on GitHub too (defaulting to no, then asking
for visibility) and wires it up as `origin`:

```
◆  Create "my-tool" on GitHub too?
│  ○ Yes / ● No
```

`--github` skips straight to creating it (private unless `--visibility` says
otherwise), `--no-github` skips the question, and `--owner` creates it under
an org. Nothing is pushed — a fresh repo has no commits yet. If the GitHub
step fails, the local repo is still created and registered.

Set `GROVE_NO_GITHUB=1` to stop grove shelling out to `gh` at all.

The repo has no commits yet, so make the first one before asking for a
worktree. Without a remote there is also no base to infer, so name it:

```bash
wt new my-tool "my task" --base main
```

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
tracking branch). Omit the branch and you get a searchable list of every local
and `origin/` branch, most recently committed first, annotated with its age and
whether it is already checked out — type to filter by branch name or commit
subject. Pass `--create` for a branch that does not exist yet, which prompts for
the new name instead.

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
wt list my-service            # print them all
```

`list`, `pick` and `cleanup` show worktrees the same way: main on top, then the
rest newest commit first, each with its status (uncommitted changes, merged,
pushed or not). The picker ends with a "Clean up worktrees…" entry. All three
take `--sort recent|name` and `--group status|none`; `cleanup` groups by status
by default, the others do not. `list --no-status` skips the git checks when
you only need names.

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
grove import ~/src/my-service --restructure --json
grove create my-tool --json
grove create my-tool --github --visibility public --json
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
`no_matching_worktree`, `ambiguous_worktree`, `alias_conflicts_with_repo`,
`not_a_repo`, `not_repo_root`, `has_linked_worktrees`, `create_target_exists`,
`gh_unavailable`, `gh_create_failed`, `invalid_visibility`.

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
main checkout. Because this is arbitrary repository-controlled shell code,
Grove does not run it by default. Review the file first, then opt in with
`--setup`. A failing command warns and continues rather than aborting the
worktree. The older `--no-setup` flag remains accepted for compatibility.

## Worktree ports

Repos can declare a port block and named service offsets in `worktree.json`:

```json
{
  "ports": {
    "perWorktree": 20,
    "worktreeSlots": 50,
    "services": {
      "webapp": {
        "offset": 0,
        "dotenv": { "env": "PORT" },
        "compose": { "target": 3000 }
      },
      "api": { "offset": 1, "dotenv": { "env": "API_PORT" } }
    }
  }
}
```

Choose a machine-local start port when cloning or registering the repo with
`--base-port 3800`, or run `grove port configure --base-port 3800` inside an
existing clone. Grove checks configured ranges against other registered repos.
The main checkout uses slot 0; new worktrees use the first free slot starting
at 1. With this example, the main checkout starts at 3800 and the first task
worktree starts at 3820. In that worktree, Grove writes `PORT=3820` to `.env`
for a host-run webapp. Its Compose override publishes `3820:3000` without
changing the container environment. The API's generated host port is 3821.

From inside a worktree, `grove port` prints its block start and
`grove port --service api` prints the service port. `dotenv.path` defaults to
`.env`. Grove writes the declared
env variables and the local Compose override after worktree setup commands.
`grove port --generate` regenerates both later; `--generate-env` and
`--generate-compose` regenerate one format. Env generation updates only the
configured variables. `grove port exec webapp -- pnpm exec next dev` starts a command with `PORT` in
its process environment, which is needed for tools such as Next.js that
choose their listening port before loading `.env`.

Grove generates `compose.override.yaml`, which Docker Compose loads
automatically, and refuses to overwrite an existing hand-written file.
`compose.target` is the container's listening port; Grove does not change
container environment variables. `dotenv.env` receives the computed host
port. Set `compose.service` when the Compose service name differs
from the Grove service name. The generated file uses Compose's `!override` tag to replace
the service's complete `ports` list,
including any fixed ports in the base file; declare every port you want to
publish for that service. This requires Docker Compose 2.24.4 or newer. Ignore
generated local files in Git.

The default is 50 secondary worktree slots. Grove warns when five or fewer
unique slots remain. After all slots are occupied, assignments wrap through
slots 1–50 and warn about the duplicate. Review eligible old worktrees with
`grove cleanup <repo> --merged --dry-run`; `git worktree prune` only clears
records for worktree directories that are already missing. See the
[port design](docs/port-offset-plan.md) and [integration conventions](docs/port-conventions.md).

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
| `managedClaudePermissions` | Internal ownership record used to revoke only Claude grants Grove added |

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

Node 24+ and pnpm 11+. With [mise](https://mise.jdx.dev), `mise install` picks
both up from `mise.toml`; otherwise see [pnpm's install
guide](https://pnpm.io/installation) — pnpm ships a native binary, so Corepack
is not involved (Node removed it in v25).

```bash
pnpm install
pnpm build       # bundle to dist/
pnpm test        # unit + integration tests against real git repos
pnpm typecheck
```

Built with TypeScript 7. Integration tests run the built bundle against
throwaway git repos with a redirected `HOME`, so they exercise what ships
without touching your real configuration.

CI runs the suite on Node 24 across Linux, macOS, and Windows.

## Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets),
which need no GitHub token and work offline. When you change something users
can observe, describe it:

```bash
pnpm changeset
```

Pick the bump and write a sentence for the release notes. Commit the generated
file with your change.

CI fails a branch that touches the package without one. That is wider than just
`src/`: changesets counts any tracked file outside a dot-directory, so `docs/`,
`test/` and this README need one too. Changes confined to `.buildkite/`,
`.github/` or `.vscode/` do not.

For a change that ships nothing users can observe — a refactor, a test, a docs
fix — add a changeset with no bump:

```bash
pnpm changeset add --empty
```

That satisfies the check and adds nothing to the changelog.

On merge to `main`, CI opens a **Publish Release** PR that applies the pending
changesets — bumping the version and folding them into `CHANGELOG.md`. The
version PR is the release gate: nothing ships until you merge it.

Merging it **stages** the release on npm rather than publishing it. Staging
needs no 2FA and so can happen in CI; approving requires 2FA and so happens
from your machine:

```bash
npm stage list @jakeginnivan/grove
npm stage view <stage-id>       # inspect before approving
npm stage approve <stage-id>    # publishes it
```

The build annotates the staged version with these commands when it finishes.
See [`npm help stage`](https://docs.npmjs.com/cli/commands/npm-stage) for the
full flow.

Releases are published with a token rather than [npm trusted
publishing](https://docs.npmjs.com/trusted-publishers/) over OIDC: npm does not
support Buildkite as a trusted publisher. Packages published this way carry no
provenance attestation, so `npm audit signatures` has nothing to verify.

## License

MIT
