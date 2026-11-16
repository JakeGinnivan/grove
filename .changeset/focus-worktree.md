---
"@jakeginnivan/grove": minor
---

Add `grove focus`, a single detached worktree beside `main/` for running an app that can only run once per machine, with `activate` and `release` hooks. `grove focus pull` moves it to the owner's latest commit, and `grove focus --watch` keeps doing that until stopped, then releases it. It is opt-in per repo through a `focus` setting in `worktree.json`. `worktree.json` can now also live in the directory holding `main/`, where it is not committed and its commands run without `--setup`.
