---
"@jakeginnivan/grove": minor
---

List branches to pick from in `wt checkout`

Omitting the branch used to open a bare text prompt, which only helped if you
already knew the branch name well enough to type it. It now shows a searchable
list of every local and `origin/` branch, most recently committed first, with
each entry annotated by its age, its commit subject, and whether it is already
checked out in another worktree. Typing filters on both the branch name and the
commit subject.

`--create` still prompts for free text, since the point there is to name a
branch that does not exist yet and there is nothing to list. Passing the branch
as an argument, `--json`, and non-interactive runs are all unchanged, so the
agent-facing contract is the same.

Branch listing now lives in one place (`listBranches`), shared with the shell
completion helper that previously had its own copy. Both gained the recency
ordering, and a local branch now correctly shadows its `origin/` twin so a
branch is only ever offered once.
