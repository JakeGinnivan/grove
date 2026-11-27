---
"@jakeginnivan/grove": minor
---

The zsh, bash and fish shell integration now runs grove with the node binary and script that generated it, through `wt`, its completions and a new `grove` function. Before, `grove` went through `node` on `PATH`, so a mise or asdf shim stopped it, and Tab completion silently offered nothing, in any repo whose tool config was untrusted. Completion now also shows `grove completion failed` with the error when grove cannot start.
