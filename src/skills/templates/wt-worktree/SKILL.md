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

Commands may prompt when run in a terminal. As an agent you must suppress that.
`--json` implies non-interactive and prints a machine-readable result on
stdout:

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
grove new <repo> --title "short description" [--issue ABC-123] --json
```

Creates a branch from the latest default branch and a matching directory:

```json
{ "ok": true, "repo": "my-service",
  "path": "/Users/you/_code/work/my-service/260810-fix-flaky-login-test",
  "branch": "you/fix-flaky-login-test", "base": "origin/main", "parent": null }
```

Use `path` as the working directory for all subsequent edits.

`grove new` fetches first, so `base` is the up-to-date remote branch. Compare
and rebase against `origin/main`, not local `main`, which is often behind.

Useful flags:

- `--issue ABC-123` — include a ticket key in the branch and directory names.
  Jira/Linear keys (`ABC-123`) and GitHub issues (`#123`) are both accepted;
  the result's `issue` field says which tracker matched. A key from one of the
  user's configured trackers already present in the title is picked up
  automatically.
- `--no-issue` — never infer a ticket key.
- `--branch <name>` — override the generated branch name.
- `--setup` — run reviewed, trusted repo-defined setup commands. Never pass
  this for an unfamiliar repository; setup is arbitrary shell code and is
  disabled by default.

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
The new branch starts at that branch's tip, and the parent is recorded in
grove's own config file (`.git/grove/config`) so the stack is discoverable
later:

```json
{ "ok": true, "branch": "you/address-review-feedback",
  "base": "you/fix-flaky-login-test",
  "parent": "you/fix-flaky-login-test" }
```

`grove list <repo> --json` reports `parent` for every stacked branch.

## Push

```bash
git push origin HEAD
```

Do not pass `-u`, and do not rely on a bare `git push` setting one up. Both
record an upstream in `.git/config`, which a sandboxed agent cannot write, so
the push succeeds and then git reports an error. grove treats `origin/<branch>`
as the upstream when none is configured, so nothing is lost.

## Inspect worktrees

```bash
grove list <repo> --json
```

Returns `path`, `branch`, `isMain`, `committedAt`, `dirty`, `upstream`,
`ahead`, `merged`, `parent`, `isFocus` and `focused` per worktree, main first
and the rest newest commit first.

## Run the app: the focus worktree

Some repos can run their app only once per machine. Those use one extra
worktree, `focus/` by default, as the single place the app runs. It holds a
worktree's commit, detached. It is opt-in per repo: `focus_not_enabled` means
the repo has not enabled it, so run the app however the repo's own docs say,
and don't enable focus yourself.

```bash
grove focus status --json      # what is focused; run this before starting the app
grove focus --json             # inside your worktree: check its HEAD out in focus/
grove focus pull --json        # after each commit: move focus/ to your latest commit
grove focus release --json     # hand it back when you are done
```

- Commit before focusing: only committed work is checked out, and a worktree
  with uncommitted changes is refused (`worktree_dirty`). After each further
  commit, run `grove focus pull`; the running app picks up the new files.
- `grove focus --watch` pulls automatically until stopped. It is for the
  user's terminal; as an agent, use `pull`.
- `focus_has_commits` means something was committed in `focus/`. Report it
  with the hint's command; don't run it or `--discard` without asking.
- If `status` shows another worktree as `owner`, someone else is testing
  there. Ask the user before taking the focus worktree over.
- Repo hooks (`activate`, `release`) prepare `focus/` and run as part of the
  command. A `focus_hook_failed` error names the command; report it rather
  than passing `--no-hooks`.
- `focus_dirty` means `focus/` has changes, usually made by the running app.
  Don't pass `--discard` without the user's say-so.
- Run the app, migrations and browser checks from `focus/`. Edit code only in
  your own worktree; never edit or commit in `focus/`.

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
- `--merged` selects everything already merged into the default branch,
  including squash and rebase merges.
  Add `--all` instead of a repo to do that across every registered repo.
- `--delete-branch` also deletes the local branch.
- `--delete-remote-branch` also deletes the branch on its remote, if it is
  still there. An unmerged branch counts as work at risk here, because
  deleting it closes any open PR: it is skipped under `--yes` like a dirty
  worktree. So is one whose remote has commits the local branch lacks.
  Without the flag, the interactive picker asks whether to delete them.

Removed worktrees go to the system trash, or, where that is not writable (as
in a sandbox), to `.grove-trash/` beside the worktrees for 14 days. The JSON
result's `trashDir` says which. Either way a mistake is recoverable.

### Reading the result

`ok: true` means the command ran, not that anything was removed. A run where
every worktree was skipped is still `ok: true`. The result splits the two:

```json
{ "ok": true, "repo": "my-service",
  "removed": [{ "repo": "my-service", "path": "...", "branch": "...", "trashed": true, "trashDir": null, "branchDeleted": true }],
  "skipped": [{ "repo": "my-service", "path": "...", "branch": "...", "reason": "has uncommitted changes; pass --force to remove" }] }
```

- With `--all`, the top level has `repos` (every repo that had worktrees)
  instead of `repo`, and each `removed` and `skipped` entry has a `repo`.
- Before telling the user a worktree is gone, find its path in `removed`.
  Report every `skipped` entry with its reason. Don't filter the JSON down
  to paths before reading it.
- Tell the user where removed worktrees went: the system trash when
  `trashDir` is null, otherwise that `.grove-trash/` folder.
- If a worktree is skipped with `could not move worktree to trash`, report
  it. Don't switch to `--no-trash`, which deletes permanently.
- After a bulk cleanup, confirm with `grove list <repo> --json` that the
  removed worktrees are no longer listed.

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
- Never edit files under `main/` — it is the shared reference checkout. The
  same goes for the focus worktree.
- Check `ok` in the JSON response before proceeding. On failure, `error.code`
  is stable and `error.hint` explains the fix.
- Run `--dry-run` before any bulk cleanup, and never pass `--force` on the
  user's behalf without being asked.
