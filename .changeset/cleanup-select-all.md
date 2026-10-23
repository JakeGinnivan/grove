---
'@jakeginnivan/grove': minor
---

`grove cleanup`'s multi-select now toggles every worktree with `a` (all, or
none when all are already selected), including in the default status-grouped
view, and says so in the prompt. When no repo is given, the repo picker for
`grove cleanup` and `grove list` shows each repo's worktree count.
