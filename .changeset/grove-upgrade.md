---
"@jakeginnivan/grove": minor
---

New `grove upgrade` command upgrades grove to the latest release with the tool that installed it: npm, pnpm, Yarn classic or mise. It checks the npm registry first and does nothing when grove is already current. `grove upgrade --check` only reports whether a newer release exists. For a grove it can't place, such as a checkout or a project dependency, it stops and lists the upgrade command for each tool.
