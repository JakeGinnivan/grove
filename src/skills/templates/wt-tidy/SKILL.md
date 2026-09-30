---
name: wt-tidy
description: Tidy a machine's grove worktrees - remove the ones whose PRs have merged, then triage the rest into rebase-and-open-a-PR or discard, with the user approving each one. Use when the user wants to clean up, tidy, or triage their worktrees or stale branches across one repo or all of them.
---

# Tidying worktrees

Three passes, in order. Each pass works from fresh state, so re-run the
listing at the start of each one.

1. **Sweep**: remove every worktree whose work has landed. No questions.
2. **Triage**: review what is left, summarise each worktree's unmerged work,
   and ask the user what to keep.
3. **Act**: rebase and open PRs for what they keep; clean up what they drop.

Pass `--json` to every `grove` command. Commands, flags, and the cleanup
safety model are in the `wt-worktree` skill; repo discovery is in `wt-repos`.

## Scope

The user names one repo, or means all of them. For all, take every entry from
`grove repos --json` with `exists: true` and `aliasOf: null` (an alias is the
same repo twice). Repos whose only worktree is `main/` drop out on their own.

Start each repo with `grove sync <repo> --json`, then
`git -C <mainPath> fetch --prune origin`, so merged status and upstreams
reflect the remote rather than a stale clone.

## Pass 1: Sweep

```bash
grove cleanup <repo> --merged --dry-run --json
grove cleanup <repo> --merged --yes --delete-branch --json
```

grove's `merged` means the branch tip is an ancestor of the default branch.
A **squash- or rebase-merged** PR fails that test, so grove reports it as
unmerged. Close the gap with GitHub, for each remaining clean worktree on a
branch:

```bash
gh pr list --repo <owner/name> --head <branch> --state merged \
  --json number,url,headRefOid,mergedAt
```

The worktree is **landed** when a merged PR exists, `git status --porcelain`
is empty, and `git rev-parse HEAD` equals that PR's `headRefOid`: every commit
it holds went into the PR. grove will skip it as "not merged, no upstream"
once the remote branch is deleted, so remove it with
`grove cleanup <repo> <dir> --force --delete-branch --yes --json`. The
landed check is what licenses `--force` here; anything that fails any part
of it goes to triage instead.

When `gh` is missing or not authenticated, skip the squash check, say so in
the report, and let those worktrees flow into triage.

Pass 1 is done when every worktree left in scope is either dirty or holds a
commit that no merged PR contains.

## Pass 2: Triage

For each remaining worktree, gather from inside it:

- `git log --oneline origin/<default>..HEAD`: the unmerged commits.
- `git diff --stat origin/<default>...HEAD` and `git status --short`: what
  changed, committed and not.
- `git rev-list --count HEAD..origin/<default>`: how far behind it is.
- The upstream and ahead count from `grove list <repo> --status --json`.
- `parent` from the same listing. A stacked branch is compared against its
  parent branch, not the default branch, everywhere in this skill.
- `gh pr list --head <branch> --state all --json number,state,isDraft,url,title`.

Read the diff itself, not just the stat, until you can say in one line what
the change does and whether it looks finished. Commit subjects alone often
describe the first commit and miss the rest.

When there are many worktrees across several repos, give each repo to a
subagent that returns the entries below, and merge the results.

Present one list to the user, grouped by repo, one entry per worktree:

```
grove
  1. 260912-add-metrics  (jake/add-metrics)
     Adds a /metrics endpoint and a counter per command. Tests pass locally,
     README not updated.
     3 commits, 12 behind main, pushed, no PR.
     Suggest: rebase, open PR.
  2. 260801-try-bun  (jake/try-bun)
     Spike swapping pnpm for bun; build script half-converted.
     1 commit + uncommitted changes, 140 behind main, never pushed.
     Suggest: discard.
```

The status line always says: commit count, uncommitted changes if any,
behind count, pushed or never pushed, and the PR (number, state, draft)
or "no PR". The suggestion is one of:

- **rebase, open PR**: finished-looking work with no open PR.
- **rebase, update PR**: an open PR that is behind.
- **leave**: an open PR that is current, or work still in progress.
- **discard**: an abandoned spike, work superseded by something on the
  default branch, or a branch with no commits and no changes.

Then ask which to keep and which to discard. Take the user's answer per
worktree; a bare "yes" confirms your suggestions. Triage is done when every
worktree has a decision from the user.

## Pass 3: Act

### Keep

Work in the worktree. For each kept one:

1. **Uncommitted changes**: ask the user whether to commit them into this
   branch, and commit only on a yes.
2. **Rebase** onto `origin/<default>`, or onto the parent branch when
   stacked. A branch that has never been pushed rebases freely. A pushed
   branch needs a force push afterwards, which rewrites published history:
   list those branches and get the user's explicit yes before rebasing
   them, then push with `git push --force-with-lease`.
3. **Conflicts**: run `git rebase --abort`, leave the branch as it was, and
   report the conflicting files. Resolve only when the user asks.
4. **Push** a branch without an upstream with `git push -u origin HEAD`.
5. **Open the PR** with `gh pr create`, based on the default branch or the
   stack parent. Write the title and body from the diff you read in triage,
   following the repo's PR template and any PR-writing skill available.
   Open it as a draft when triage said the work looked unfinished.

A refused push or a failed commit signature is reported, not worked around.

### Discard

```bash
grove cleanup <repo> <dir> --dry-run --json
grove cleanup <repo> <dir> --force --delete-branch --yes --json
```

The user's discard answer is what licenses `--force`. Removed worktrees go to
the trash, so they are recoverable. When a discarded branch has an open PR,
ask whether to close it; the remote branch and PR stay otherwise.

## Report

Finish with a table per repo: each worktree, what happened (swept, rebased,
PR opened with its URL, left, discarded), and anything skipped with the
reason. Call out every rebase that hit conflicts and every step that needed
something the user has not yet given.
