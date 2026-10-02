---
'@jakeginnivan/grove': minor
---

`grove skills install` can add hints for Claude Code's auto mode to
`~/.claude/settings.json`, so the classifier stops blocking `grove cleanup`
without `--force`. It is opt-in: a prompt, or `--claude-auto-mode`
(`--no-claude-auto-mode` skips it). It keeps `$defaults`, writes through a
symlinked settings file, and updates grove's own entries in place on re-run.
