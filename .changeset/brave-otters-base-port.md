---
'@jakeginnivan/grove': patch
---

Fix base-port configuration failing under a symlinked path.

`grove clone --base-port` aborted with "Current directory is not a registered
worktree" whenever the clone target was reached through a symlink — which
includes macOS `/tmp` and any symlinked home. Port slot assignment compares the
path against `git worktree list`, which git always reports as a realpath, so the
paths never matched. `clone` and `import` now canonicalise before assigning.
