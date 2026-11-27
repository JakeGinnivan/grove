---
"@jakeginnivan/grove": minor
---

`grove skills install` now updates. Once grove's skills are installed somewhere, running it without `--target` brings those tools up to this version without the tool picker or the auto mode question, adds any skill the new version introduced, and names newly detected tools instead of installing into them. grove records what it wrote, so it replaces a skill an older grove wrote and leaves one you edited unless you pass `--force`. `grove skills list` shows each skill as up to date, outdated or edited locally, and other commands end with a one-line reminder while skills are outdated. In `--json` output, `skipped` now lists only skills edited locally; up-to-date skills are in the new `current` list, replaced ones in `updated`, and untouched detected tools in `notInstalled`.
