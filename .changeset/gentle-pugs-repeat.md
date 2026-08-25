---
"@jakeginnivan/grove": patch
---

Restore the cursor and dim placeholder in prompts run under `wt`

clack styles prompts with `util.styleText`, which decides whether to emit ANSI
codes by looking at `process.stdout`. The `wt` shell function captures stdout
with `$(...)` to read the cd sentinel, so stdout is a pipe and all styling was
stripped — even though the prompt renders to stderr, which is still a terminal.

The visible effect was a prompt with no cursor and a placeholder that read as
already-entered text: `Short alias for "atlassian-career"? (optional)` followed
by a plain `atl`, rather than an inverse cursor block and a dimmed hint.
Colour is now re-enabled when stderr is a TTY, unless `NO_COLOR` or
`FORCE_COLOR` says otherwise.
