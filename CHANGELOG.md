# @jakeginnivan/grove

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
