---
'@jakeginnivan/grove': minor
---

`grove list`, `grove pick` and `grove cleanup` now share one view of your
worktrees: main on top, the rest newest commit first, and every row shows its
status, including whether the branch is pushed. `list` shows status by default
(`--no-status` skips it). All three accept `--sort recent|name` and
`--group status|none`; `cleanup` still groups by status by default.
`list --json` gains a `committedAt` field.

A branch with no commits of its own no longer shows as merged. It shows
`= origin/main`, or how far behind `origin/main` it is, and `cleanup` groups
these under "No commits of its own", preselects them like merged ones, and
includes them in `--merged`. Main shows when it is behind `origin/main` too.
