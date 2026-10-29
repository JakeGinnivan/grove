---
'@jakeginnivan/grove': patch
---

In `grove cleanup`'s picker, `a` now toggles only the merged, clean
worktrees (the ones selected at the start) instead of every worktree, and
the footer says `a: merged & clean / none`. `i` (invert) is turned off there,
since it would select exactly the worktrees with work to lose. Other
multi-selects keep `a: all / none`.
