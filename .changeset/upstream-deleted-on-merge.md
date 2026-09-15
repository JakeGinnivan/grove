---
'@jakeginnivan/grove': patch
---

Fix `list` and `cleanup` failing on a worktree whose upstream branch was deleted on merge

With `delete_branch_on_merge` enabled, merging a PR deletes the remote branch. After a
prune the local `branch.<name>.merge` config still names the gone ref, and
`git rev-parse --abbrev-ref --symbolic-full-name @{u}` exits non-zero while *also*
echoing the literal `@{u}` on stdout. `upstreamOf` read stdout without checking the exit
code, so it returned `"@{u}"` as if it were a branch name, and `aheadCount` then ran
`git rev-list --count @{u}..HEAD`, which failed the whole command:

```
git rev-list --count @{u}..HEAD failed: fatal: ambiguous argument '@{u}..HEAD'
```

That took out `grove list --status`, `grove cleanup --merged`, and cleanup by path — for
exactly the worktrees most likely to be finished with. `upstreamOf` now honours the exit
code, and `aheadCount` treats an unresolvable upstream as "not ahead" rather than an
error.
