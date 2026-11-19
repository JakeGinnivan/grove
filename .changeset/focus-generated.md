---
"@jakeginnivan/grove": minor
---

Add `focus.generated` to `worktree.json`: glob paths for files the running app rewrites, such as a schema dump. Changes to them no longer make the focus worktree dirty, and grove puts them back as committed before each checkout, so they cannot block `grove focus` or `grove focus pull`.
