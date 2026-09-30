---
'@jakeginnivan/grove': minor
---

New `wt-tidy` agent skill. It removes worktrees whose PRs have merged,
including squash merges that git ancestry misses, then summarises the
unmerged work in every remaining worktree so you can pick which to rebase
and open PRs for and which to discard.
