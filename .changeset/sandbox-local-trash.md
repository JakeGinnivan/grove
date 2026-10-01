---
'@jakeginnivan/grove': patch
---

`grove cleanup` works inside Claude Code's sandbox again. The sandbox cannot
write `~/.Trash`, so every worktree was skipped with "could not move worktree to
trash". When the system trash refuses, removed worktrees now move to a
`.grove-trash/` folder beside the worktrees, which is cleared after 14 days.
The result says where each one went (`trashDir` in `--json`).
