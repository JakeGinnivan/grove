---
"@jakeginnivan/grove": minor
---

Add `grove focus`, a single detached worktree beside `main/` for running an app that can only run once per machine, with `activate` and `release` hooks. `worktree.json` can now also live in the directory holding `main/`, where it is not committed and its commands run without `--setup`.
