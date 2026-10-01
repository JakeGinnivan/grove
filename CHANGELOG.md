# @jakeginnivan/grove

## 0.6.0

### Minor Changes

- 5678d24: `grove list`, the `grove pick` picker and the `cleanup` picker now show
  worktrees most recent first, ordered by each worktree's latest commit. The main
  checkout stays pinned at the top, and `grove list` leaves a gap after it.

  The `grove pick` picker also shows each worktree's status the way `cleanup`
  does (uncommitted changes, merged, unpushed, no upstream), and ends with a
  "Clean up worktrees…" entry that opens the cleanup picker.

- 8ffdcc1: `grove list`, `grove pick` and `grove cleanup` now share one view of your
  worktrees: main on top, the rest newest commit first, and every row shows its
  status, including whether the branch is pushed. `list` shows status by default
  (`--no-status` skips it). All three accept `--sort recent|name` and
  `--group status|none`; `cleanup` still groups by status by default.
  `list --json` gains a `committedAt` field.

  A branch with no commits of its own no longer shows as merged. It shows
  `= origin/main`, or how far behind `origin/main` it is, and `cleanup` groups
  these under "No commits of its own", preselects them like merged ones, and
  includes them in `--merged`. Main shows when it is behind `origin/main` too.

- 6568b31: New `wt-tidy` agent skill. It removes worktrees whose PRs have merged,
  including squash merges that git ancestry misses, then summarises the
  unmerged work in every remaining worktree so you can pick which to rebase
  and open PRs for and which to discard.

### Patch Changes

- d8f92e9: `grove cleanup` works inside Claude Code's sandbox again. The sandbox cannot
  write `~/.Trash`, so every worktree was skipped with "could not move worktree to
  trash". When the system trash refuses, removed worktrees now move to a
  `.grove-trash/` folder beside the worktrees, which is cleared after 14 days.
  The result says where each one went (`trashDir` in `--json`).
- 206a955: grove now works from inside Claude Code's sandbox, which never lets a command
  write a repo's `.git/config`.

  - Stack parents and port settings are stored in `.git/grove/config` instead of
    `.git/config`, so `grove new --on` and port assignment no longer fail
    halfway. Values older versions wrote to `.git/config` are still read.
  - A branch with no configured upstream is compared against where `git push`
    sends it, or `origin/<branch>`, so a branch pushed with `git push origin HEAD`
    shows as pushed with the right unpushed count.
  - The `wt-worktree` skill tells agents to push with `git push origin HEAD`
    rather than `-u`.

- f89bb9a: The `wt-worktree` skill now tells agents to compare and rebase against
  `origin/main` rather than local `main`, which is often behind.

## 0.5.0

### Minor Changes

- 677d453: Add `grove import` and `grove create`.

  `grove import <path>` adopts an existing local repo. When the repo is a plain
  clone rather than the `<repo>/main` layout grove expects, it says so and offers
  to move the checkout into a `main/` subfolder in place, leaving the repo's own
  path unchanged. `--restructure` / `--no-restructure` decide without prompting,
  and `--profile` / `--dir` can also relocate the repo under a profile directory.
  A repo with linked worktrees is refused rather than silently broken.

  `grove create <name>` starts a new repo at `<profile-dir>/<name>/main` with
  `git init` on branch `main` and registers it, prompting for the profile when
  several are configured.

- 385c669: `grove create` can now create the repo on GitHub.

  When the GitHub CLI is installed and logged in, `create` offers to create the
  repo on GitHub and wire it up as `origin`, asking for visibility (defaulting to
  private). `--github` / `--no-github` decide without prompting, `--visibility`
  picks private/public/internal, and `--owner` creates under an org. Nothing is
  pushed, since a freshly created repo has no commits. A GitHub failure never
  costs you the local repo, which is created and registered first.

  Set `GROVE_NO_GITHUB=1` to stop grove invoking `gh` at all.

- 385c669: Deprecate `grove repos add` in favour of `grove import`.

  `repos add` now forwards to `grove import --no-restructure`, which registers
  the repo exactly as it did before, and prints a deprecation warning (carried in
  the `deprecated` field under `--json`). It is hidden from help and will be
  removed in v1. Use `grove import` instead, which can also fix a layout that is
  not `<repo>/main`.

- 0103461: The `cleanup` picker now groups worktrees into Merged, Clean (not merged) and
  Uncommitted changes, preselects the merged ones, and shows each worktree's
  status on every row instead of only the highlighted one.

### Patch Changes

- 403d43b: Fix base-port configuration failing under a symlinked path.

  `grove clone --base-port` aborted with "Current directory is not a registered
  worktree" whenever the clone target was reached through a symlink — which
  includes macOS `/tmp` and any symlinked home. Port slot assignment compares the
  path against `git worktree list`, which git always reports as a realpath, so the
  paths never matched. `clone` and `import` now canonicalise before assigning.

- 80f0934: Create the GitHub release again when a version is staged. The move from GitHub
  Actions to Buildkite dropped `changesets/action`, which had been creating them,
  so v0.3.2 shipped with a tag but no release. The release body is the version's
  CHANGELOG.md section plus the `npm stage approve` command for that stage id, so
  merging the version PR delivers everything needed to finish the release.
- d5dced4: The release PR is now titled "Publish Release" and lists the changelog entries
  it will ship. Later builds keep the title and body of an open release PR up to date.
- c8587b9: Run the changeset check through a vendored copy of the changesets Buildkite
  plugin, so the extracted plugin is proven on a real build before it is tagged.
  The duplicate `changeset-check.sh` and `is-version-pr.sh` are removed, leaving
  one copy of that logic rather than two that can drift.

## 0.4.0

### Minor Changes

- a59ca3d: Assign stable port blocks to worktrees, generate configured environment variables
  and local Docker Compose overrides, and support service port lookup and
  launch-time injection.

## 0.3.2

### Patch Changes

- 2c8fe78: Release pipeline now stages to npm for approval instead of publishing directly,
  and the build names which half of the release it is running before it starts.

## 0.3.1

### Patch Changes

- 9fcfc74: Fix branch listing on git older than 2.42. `for-each-ref --exclude` was added
  in git 2.42, and on older versions the whole command failed, which surfaced as
  an empty branch list in `grove checkout` and shell completion rather than an
  error. The `<remote>/HEAD` ref is now filtered in code instead.
- b32a21e: Fix `list` and `cleanup` failing on a worktree whose upstream branch was deleted on merge

  With `delete_branch_on_merge` enabled, merging a PR deletes the remote branch. After a
  prune the local `branch.<name>.merge` config still names the gone ref, and
  `git rev-parse --abbrev-ref --symbolic-full-name @{u}` exits non-zero while _also_
  echoing the literal `@{u}` on stdout. `upstreamOf` read stdout without checking the exit
  code, so it returned `"@{u}"` as if it were a branch name, and `aheadCount` then ran
  `git rev-list --count @{u}..HEAD`, which failed the whole command:

  ```
  git rev-list --count @{u}..HEAD failed: fatal: ambiguous argument '@{u}..HEAD'
  ```

  That took out `grove list --status`, `grove cleanup --merged`, and cleanup by path — for
  exactly the worktrees most likely to be finished with. `upstreamOf` now honours the exit
  code, and `aheadCount` treats an unresolvable upstream as "not ahead" rather than an
  error.

## 0.3.0

### Minor Changes

- 9dd9110: Make repository setup commands explicitly opt-in, harden worktree cleanup, revoke stale managed permissions, and validate registry identifiers.
- da990ca: List branches to pick from in `wt checkout`

  Omitting the branch used to open a bare text prompt, which only helped if you
  already knew the branch name well enough to type it. It now shows a searchable
  list of every local and `origin/` branch, most recently committed first, with
  each entry annotated by its age, its commit subject, and whether it is already
  checked out in another worktree. Typing filters on both the branch name and the
  commit subject.

  `--create` still prompts for free text, since the point there is to name a
  branch that does not exist yet and there is nothing to list. Passing the branch
  as an argument, `--json`, and non-interactive runs are all unchanged, so the
  agent-facing contract is the same.

  Branch listing now lives in one place (`listBranches`), shared with the shell
  completion helper that previously had its own copy. Both gained the recency
  ordering, and a local branch now correctly shadows its `origin/` twin so a
  branch is only ever offered once.

## 0.2.2

### Patch Changes

- a5bd08a: Restore the cursor and dim placeholder in prompts run under `wt`

  clack styles prompts with `util.styleText`, which decides whether to emit ANSI
  codes by looking at `process.stdout`. The `wt` shell function captures stdout
  with `$(...)` to read the cd sentinel, so stdout is a pipe and all styling was
  stripped — even though the prompt renders to stderr, which is still a terminal.

  The visible effect was a prompt with no cursor and a placeholder that read as
  already-entered text: `Short alias for "atlassian-career"? (optional)` followed
  by a plain `atl`, rather than an inverse cursor block and a dimmed hint.
  Colour is now re-enabled when stderr is a TTY, unless `NO_COLOR` or
  `FORCE_COLOR` says otherwise.

## 0.2.1

### Patch Changes

- 15db208: Report the real version, and accept `-v` for it

  The version was a hardcoded constant in `src/cli.ts` that nothing kept in step
  with `package.json`, so every release after 0.1.0 would have kept reporting
  `0.1.0` no matter which version was installed. It is now read from
  `package.json` at startup, leaving changesets' bump as the only place a version
  is written.

  The flag is `-v` rather than commander's default `-V`; nothing here uses `-v`
  for verbosity.

## 0.2.0

### Minor Changes

- d51cdc9: Render interactive prompts on stderr so they are visible under the shell wrapper, and require Node 24

  The `wt` shell function captures stdout with `$(...)` to read the cd sentinel, which meant prompts drawn on stdout were swallowed — `wt clone` appeared to hang with no visible question. The captured prompt frame also broke the sentinel match, so the wrapper printed a raw `__WT_CD__/path/to/repo` line instead of changing directory.

  `engines.node` moves from `>=20` to `>=24`. Node 20 is out of support, and Node 24 is the version grove is now built and tested against; installing on an older runtime fails up front with `EBADENGINE` rather than at the first unsupported API. Upgrade to Node 24 before taking this release.

## 0.1.0

Initial release.

A git worktree manager: clone once, then work on several branches at the same
time in separate directories.

- `grove new` / `grove checkout` create worktrees with dated, branch-derived
  directory names, optionally stacked on another branch with `--on`.
- `grove pick`, `grove list`, and `grove sync` move between worktrees and keep
  the main checkout current.
- `grove cleanup` removes finished worktrees, skipping any with uncommitted
  changes or unpushed commits unless forced.
- Profiles group repos under a base directory, wiring up `includeIf` git config
  and agent read permissions for each.
- Shell integration for zsh, bash, fish, and PowerShell provides a `wt`
  function with directory-changing and tab completion.
- Every command runs unattended, with `--json` output for coding agents, and
  bundled agent skills teach assistants to drive it.
