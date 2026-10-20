---
"@jakeginnivan/grove": minor
---

Task trackers are now a setting. `grove setup` asks which of Jira, Linear and GitHub Issues to use (or `--task-trackers github,jira`, or `none`). `grove new` only detects and prompts for keys from the enabled trackers, works out the tracker from the key's format, and skips the prompt when none are enabled. `--issue <key>` and `--no-issue` join `--jira`/`--no-jira`, and `--json` output reports the matched `issue`.
