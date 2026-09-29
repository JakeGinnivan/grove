---
'@jakeginnivan/grove': patch
---

Create the GitHub release again when a version is staged. The move from GitHub
Actions to Buildkite dropped `changesets/action`, which had been creating them,
so v0.3.2 shipped with a tag but no release. The release body is the version's
CHANGELOG.md section plus the `npm stage approve` command for that stage id, so
merging the version PR delivers everything needed to finish the release.
