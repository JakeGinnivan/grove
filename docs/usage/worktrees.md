# Worktrees

Examples use `wt`; `grove` works identically.

## Start work on something

```bash
wt new my-service "fix flaky login test"
```

Creates the branch `you/fix-flaky-login-test` from the latest `origin/HEAD`,
puts it in `260810-fix-flaky-login-test/`, and cd's you into it. The branch
prefix comes from [`grove setup`](configuration.md).

### Ticket keys

```bash
wt new my-service "fix login" --jira ABC-123
#   branch:   you/ABC-123-fix-login
#   worktree: 260810-fix-login-ABC-123
```

A key already present in the title is detected automatically. Which formats
are recognised, and whether `grove new` prompts for a key at all, depends on
the task trackers enabled with `grove setup`:

| Tracker | Key | Branch |
| --- | --- | --- |
| `jira` | `ABC-123` | `you/ABC-123-fix-login` |
| `linear` | `ABC-123` | `you/ABC-123-fix-login` |
| `github` | `#123` (or `123` / an issue URL at the prompt) | `you/123-fix-login` |

With several enabled, type any of them at the prompt and the format picks the
tracker. With none enabled there is no prompt. `--issue <key>` passes one
explicitly; `--no-issue` skips detection for one run.

## Check out an existing branch

```bash
wt checkout my-service colleague/their-branch
```

Resolves a local branch first, then `origin/<branch>` (creating a local
tracking branch). Omit the branch and you get a searchable list of every local
and `origin/` branch, most recently committed first, annotated with its age and
whether it is already checked out — type to filter by branch name or commit
subject. Pass `--create` for a branch that does not exist yet, which prompts for
the new name instead.

## Stack a branch on another

By default a new worktree branches off the latest main. To build on work that
is not merged yet:

```bash
wt new my-service "address feedback" --on 260810-fix-flaky-login-test
```

`--on` accepts a worktree directory, a worktree path, or a branch name. The
parent is recorded in grove's own config file, `.git/grove/config`
(`branch.<name>.wt-parent`), so `wt list` shows the stack:

```
260810-fix-flaky-login-test  you/fix-flaky-login-test
260810-address-feedback      you/address-feedback   on you/fix-flaky-login-test
```

## Pushing

Push with `git push origin HEAD`. grove treats `origin/<branch>` as the
branch's upstream when none is configured, so `-u` is not needed, and agents in
Claude Code's sandbox cannot use it: recording an upstream writes
`.git/config`, which the sandbox never allows.

grove keeps all of its own state (stack parents, port settings) in
`.git/grove/config` for the same reason, and still reads values older versions
wrote to `.git/config`.

## Move around

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

Without the shell integration, commands print the path instead of jumping, so
`cd "$(grove pick my-service)"` works too.

## Keep main current

```bash
wt sync my-service   # fetch + fast-forward the main checkout
wt sync              # every registered repo
```

`sync` only fast-forwards when the main checkout is clean and on the default
branch. Otherwise it reports why it skipped and changes nothing.

## Clean up

```bash
wt cleanup my-service                    # interactive multi-select
wt cleanup my-service --merged --yes     # everything already merged
wt cleanup my-service 260810-old --yes   # a specific worktree
wt cleanup self                          # the worktree you are standing in
wt cleanup --all                         # pick from every repo at once
wt cleanup --all --merged --yes          # everything merged, in every repo
```

Without a repo, `cleanup` (and `list`) asks which one, showing how many
worktrees each has. `cleanup` lists "All repos" first, the same as `--all`:
one multi-select with every repo's worktrees, grouped by repo.

The multi-select starts with every merged, clean worktree selected. `a`
selects those same worktrees again, or clears them when they are all
selected, and leaves anything you picked by hand alone. A worktree with
uncommitted or unpushed work is only ever selected one at a time, with Space
or its group heading.

Worktrees with uncommitted changes or unpushed commits are **skipped** unless
you pass `--force`, and `--yes` alone will not override that. `--dry-run`
shows what would happen.

Removed directories go to the system trash where available. Where it is not,
such as inside Claude Code's sandbox, which cannot write `~/.Trash`, they move
to a `.grove-trash/` folder beside the worktrees instead, and entries there are
deleted after 14 days.

For squash-merged PRs that git ancestry cannot detect, the `wt-tidy`
[agent skill](agents.md) checks PR state with `gh`.
