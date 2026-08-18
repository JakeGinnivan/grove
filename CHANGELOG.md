# @jakeginnivan/grove

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
