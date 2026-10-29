---
'@jakeginnivan/grove': minor
---

`grove cleanup --delete-remote-branch` also deletes each removed worktree's branch on its remote, when the remote still has it. A branch that is not merged, or whose remote has commits the local branch lacks, is treated as work at risk and skipped under `--yes` unless you pass `--force`.
