# @jakeginnivan/grove

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
