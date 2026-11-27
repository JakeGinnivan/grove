---
"@jakeginnivan/grove": minor
---

New `grove upgrade` command upgrades grove to the latest release with the tool that installed it: npm, pnpm, Yarn classic or mise. It checks the npm registry first and does nothing when grove is already current. Afterwards it confirms the grove on `PATH` really is the new version, and warns when the package manager finished without upgrading, as mise does for a release younger than its `minimum_release_age`. `grove upgrade --check` only reports whether a newer release exists. For a grove it can't place, such as a checkout or a project dependency, it stops and lists the upgrade command for each tool.
