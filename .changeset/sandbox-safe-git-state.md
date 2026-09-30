---
'@jakeginnivan/grove': patch
---

grove now works from inside Claude Code's sandbox, which never lets a command
write a repo's `.git/config`.

- Stack parents and port settings are stored in `.git/grove/config` instead of
  `.git/config`, so `grove new --on` and port assignment no longer fail
  halfway. Values older versions wrote to `.git/config` are still read.
- A branch with no configured upstream is compared against where `git push`
  sends it, or `origin/<branch>`, so a branch pushed with `git push origin HEAD`
  shows as pushed with the right unpushed count.
- The `wt-worktree` skill tells agents to push with `git push origin HEAD`
  rather than `-u`.
