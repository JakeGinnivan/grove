---
"@jakeginnivan/grove": patch
---

`cleanup` runs `git clean -dfX` on a worktree before moving it to the trash, so
ignored files like `node_modules` and build output are deleted rather than
filling the trash. Untracked files that aren't ignored are kept, so a forced
removal of a dirty worktree can still be recovered from the trash.
