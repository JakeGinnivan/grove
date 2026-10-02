---
'@jakeginnivan/grove': minor
---

`grove cleanup --json` now lists skipped worktrees under `skipped` (with a
`reason`) instead of inside `removed`. `removed` holds only worktrees that
were actually removed. Previously a skipped worktree appeared in `removed`
with `removed: false`, which agents misread as a successful removal.

The `wt-worktree` skill now explains how to read the result: check each path
is in `removed`, report each `skipped` reason, and say where removed
worktrees went (`trashDir`).
