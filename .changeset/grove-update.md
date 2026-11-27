---
"@jakeginnivan/grove": minor
---

Add `grove update`, which brings the installed agent skills up to the running version for every tool that already has them, without prompting, and reports on the shell integration. grove now records what it wrote, so `grove skills install` replaces a skill an older grove wrote, leaves one you edited unless you pass `--force`, and `grove skills list` shows each skill as up to date, outdated or edited locally. Other commands end with a one-line reminder to run `grove update` while skills are outdated. In `--json` output from `grove skills install`, `skipped` now lists only skills that were edited locally; skills already up to date appear in the new `current` list, and replaced ones in `updated`.
