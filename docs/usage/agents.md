# Agent support

grove is built to be driven by coding agents as well as people: it ships skills
that teach agents how to use it, and every command runs unattended with
machine-readable output.

## Install the skills

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

Three skills are installed:

- **wt-repos** — discovering cloned repos and their paths, which
  [profile](profiles.md) each belongs to and what rules apply, and running
  `grove sync` before reading code so the agent is not reasoning about a stale
  checkout.
- **wt-worktree** — creating worktrees for tasks, checking out branches,
  stacking work, and cleaning up safely.
- **wt-tidy** — sweeping away worktrees whose PRs have merged (including
  squash merges, via `gh`), then summarising what is unmerged in the rest so
  you can choose which to rebase and open PRs for and which to discard.

Each tool reads skills from its own directory, so grove writes a copy per
tool. Supported: `claude`, `codex`, `copilot`, `cursor`, `gemini`, and
`opencode`. Skip the prompt with `--target`:

```bash
grove skills install --target claude codex   # named tools
grove skills install --target all            # every known tool
grove skills install --target ~/somewhere    # an explicit directory
```

Without a TTY (`--json`, CI, or an agent), install goes to every detected
tool without prompting.

```bash
grove skills list        # where each skill is installed, and whether it is up to date
grove skills uninstall   # remove them
```

### After upgrading grove

After `grove upgrade`, or upgrading grove any other way, run
`grove skills install` again. Once grove's skills are installed somewhere,
install without `--target` updates the tools that already have them, without
the tool picker or the auto mode question, and adds any skill the new version
introduced. A tool detected since then is named rather than installed into;
add it with `--target`. While skills are behind, other grove commands end with
a one-line reminder.

grove records a hash of each skill it writes in `~/.config/grove/skills.json`,
which is how it tells the two kinds of difference apart:

| Status | Meaning | What `grove skills install` does |
| --- | --- | --- |
| up to date | Same as this version's skill | Nothing |
| outdated | Still what grove wrote, and this version has a newer one | Replace it |
| edited locally | Changed since grove wrote it | Leave it, with a warning; `--force` replaces it |

A skill installed by a grove older than these records has no hash. If it
differs from this version's, it counts as outdated and is replaced.

The shell integration needs no update: the line in your startup file runs
`grove shell-init` each time a shell starts, so every new terminal has the
installed version's script.

## Claude Code auto mode

When installing for Claude Code, grove offers to add two hints to
`~/.claude/settings.json` for
[auto mode](https://code.claude.com/docs/en/auto-mode-config). Without them,
the auto mode classifier sees `grove cleanup` as a command that deletes
directories, and blocks routine cleanups.

- `autoMode.environment` describes grove and which commands are read-only.
- `autoMode.allow` allows `grove cleanup` **without** `--force`, which skips
  anything with uncommitted or unpushed work and moves what it removes to the
  trash or `.grove-trash/`. `--force` stays subject to the classifier.

It is opt-in. Answer yes at the prompt, or pass `--claude-auto-mode`. Without
a TTY nothing changes unless the flag is passed, and `--no-claude-auto-mode`
skips the offer. A list grove creates starts with `"$defaults"`, so Claude
Code's built-in rules stay in effect. Existing lists are appended to as
written. A symlinked settings file (for example into a dotfiles repo) is
written through, not replaced. Re-running install updates grove's wording in
place. Check the result with `claude auto-mode config`.

## Non-interactive commands

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
Prompts are also skipped automatically when stdin is not a TTY.

## Errors

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
