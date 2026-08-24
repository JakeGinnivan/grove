---
'@jakeginnivan/grove': patch
---

Fix two Windows path bugs

`git worktree list --porcelain` reports forward slashes even on Windows, but worktree paths built with `node:path` use backslashes. The two never compared equal, so `wt pick`, `wt checkout`, and `wt list` failed to match a worktree by path and the cd sentinel pointed at a differently-spelled path than `wt new` had just printed. Paths from git are now normalised to the platform separator as they are parsed.

`repoNameFromUrl` split only on `/` and `:`. Cloning from a local path or network share on Windows cut at the drive letter's colon, so `C:\repos\thing.git` produced the repo name `\repos\thing` instead of `thing`. It now treats a backslash as a separator too.

Profile paths written into git config are now spelled with forward slashes. git reads `\` as an escape character, so a Windows path in an `includeIf "gitdir:..."` pattern never matched and the per-profile gitconfig silently never applied.
