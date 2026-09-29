---
'@jakeginnivan/grove': patch
---

Run the changeset check through a vendored copy of the changesets Buildkite
plugin, so the extracted plugin is proven on a real build before it is tagged.
The duplicate `changeset-check.sh` and `is-version-pr.sh` are removed, leaving
one copy of that logic rather than two that can drift.
