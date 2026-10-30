---
'@jakeginnivan/grove': minor
---

Squash- and rebase-merged branches now count as merged in `grove list`, `grove pick` and `grove cleanup`, so `cleanup --merged` and the picker's preselection include them. They show as `✔ squash-merged`, and `--json` reports `squashMerged: true` alongside `merged`. A squash whose conflicts were resolved differently from the branch is not recognised.
