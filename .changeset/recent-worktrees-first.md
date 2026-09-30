---
'@jakeginnivan/grove': minor
---

`grove list`, the `grove pick` picker and the `cleanup` picker now show
worktrees most recent first, ordered by each worktree's latest commit. The main
checkout stays pinned at the top, and `grove list` leaves a gap after it.

The `grove pick` picker also shows each worktree's status the way `cleanup`
does (uncommitted changes, merged, unpushed, no upstream), and ends with a
"Clean up worktrees…" entry that opens the cleanup picker.
