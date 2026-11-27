---
"@jakeginnivan/grove": patch
---

Security: bash Tab completion no longer runs branch names as shell code. It passed branch, worktree and repo names through `compgen -W`, which expands `$(...)` and backticks, and git allows both in branch names. Anyone who could push a branch to a repo you cloned could run commands on your machine when you pressed Tab after `wt checkout <repo>`. Completions are now filtered without expansion and escaped when inserted. PowerShell completions are now single-quoted when they hold special characters, so accepting one can't run it either. `grove shell-init --name` now accepts only a plain command name.
