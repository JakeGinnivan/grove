# @jakeginnivan/grove

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
