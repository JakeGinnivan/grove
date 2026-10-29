---
'@jakeginnivan/grove': minor
---

`grove cleanup` can now clean up every repo at once. The repo picker lists
"All repos" first, and `--all` does the same without the prompt (it combines
with `--merged`, `--dry-run` and `--yes`). Worktrees are grouped by repo in a
single multi-select. JSON results gain a `repo` on each `removed`, `skipped`
and `wouldRemove` entry, and `--all` runs report `repos` in place of `repo`.
