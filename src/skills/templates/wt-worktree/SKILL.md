---
name: wt-worktree
description: Create an isolated git worktree to work on a task, check out an existing branch into its own directory, stack a branch on top of another in-progress branch, or clean up finished worktrees. Use whenever starting work on a new task, ticket, or branch in a repository managed by grove.
---

# Working in git worktrees

`grove` creates a separate directory per task, so several branches can be
worked on at once without stashing or switching. Each worktree shares one
clone.

The `wt` command in the user's shell is a thin wrapper around `grove` that
adds directory-changing. In tool calls, invoke `grove` directly.

Layout for a repo:

```
~/_code/work/my-service/
  main/                     <- primary checkout, read-only reference
  260810-fix-login/         <- a task worktree
  260811-add-metrics-ABC-1/ <- another, with a Jira key
```

Find repos, their paths, and their profile rules with the `wt-repos` skill.

## Always pass --json

Every command below prompts when run in a terminal. As an agent you must
suppress that. `--json` implies non-interactive and prints a machine-readable
result on stdout:

```bash
grove new my-service --title "fix flaky login test" --json
```

If a required value is missing, the command exits with code 2 and names the
flag to pass, rather than hanging on a prompt:

```json
{ "ok": false, "error": { "code": "needs_input",
  "message": "A title is required in non-interactive mode.",
  "hint": "Pass --title, or run in an interactive terminal." } }
```

## Start a new task

```bash
grove new <repo> --title "short description" [--jira ABC-123] --json
```

Creates a branch from the latest default branch and a matching directory:

```json
{ "ok": true, "repo": "my-service",
  "path": "/Users/you/_code/work/my-service/260810-fix-flaky-login-test",
  "branch": "you/fix-flaky-login-test", "base": "origin/main", "parent": null }
```

Use `path` as the working directory for all subsequent edits.

Useful flags:

- `--jira ABC-123` — include a ticket key in the branch and directory names.
  A key already present in the title is picked up automatically.
- `--no-jira` — never prompt for or infer a ticket key.
- `--branch <name>` — override the generated branch name.
- `--no-setup` — skip repo-defined setup commands (dependency installs, etc).

## Check out an existing branch

To review or continue someone else's branch, give it its own worktree:

```bash
grove checkout <repo> <branch> --json
```

This resolves the branch in order: an existing local branch, then
`origin/<branch>` (creating a local tracking branch). If the branch does not
exist anywhere, the command fails unless you pass `--create`.

The response includes `"source": "local" | "remote" | "none"` so you can tell
what happened. If the branch is already checked out somewhere, the existing
path is returned with `"created": false` — this is a success, not an error.

## Stack a branch on another

By default a new worktree branches from the latest default branch. To build on
top of work that is not merged yet, pass `--on`:

```bash
grove new <repo> --title "address review feedback" --on 260810-fix-flaky-login-test --json
```

`--on` accepts a worktree directory name, a worktree path, or a branch name.
The new branch starts at that branch's tip, and the parent is recorded in git
config (`branch.<name>.wt-parent`) so the stack is discoverable later:

```json
{ "ok": true, "branch": "you/address-review-feedback",
  "base": "you/fix-flaky-login-test",
  "parent": "you/fix-flaky-login-test" }
```

`grove list <repo> --json` reports `parent` for every stacked branch.

Stacked branches have no upstream until you push. When pushing one, set the
upstream explicitly: `git push -u origin HEAD`.

## Inspect worktrees

```bash
grove list <repo> --json
```

Returns `path`, `branch`, `isMain`, `dirty`, `upstream`, `ahead`, `merged`,
and `parent` per worktree.

## Clean up

```bash
grove cleanup <repo> <worktree-dir> --yes --json
```

Safety model — read this before automating removal:

- A worktree with uncommitted changes or unpushed commits is **skipped**, even
  with `--yes`. The result reports a `skipped` reason.
- `--force` overrides that and discards the work. Only use it when the user
  has explicitly said the work is disposable.
- `--dry-run` reports what would be removed without touching anything. Prefer
  this first when cleaning up several worktrees.
- `--merged` selects everything already merged into the default branch.
- `--delete-branch` also deletes the local branch.

Removed worktrees go to the system trash where supported, so a mistake is
usually recoverable.

## Profiles

Repositories live under profile directories that carry their own policy —
in particular whether code may be shared with other profiles. Before copying
code between two repositories, check `grove profile list --json` and follow
the rules there. Copying source across profiles can create licensing
problems; see the `wt-repos` skill.

If a push is refused by git configuration, report it to the user; do not work
around it.

## Rules

- One task per worktree. Do not create a branch inside an existing worktree
  with `git checkout -b`; use `grove new` so the directory and branch stay
  aligned.
- Never edit files under `main/` — it is the shared reference checkout.
- Check `ok` in the JSON response before proceeding. On failure, `error.code`
  is stable and `error.hint` explains the fix.
- Run `--dry-run` before any bulk cleanup, and never pass `--force` on the
  user's behalf without being asked.
