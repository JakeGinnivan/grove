---
"@jakeginnivan/grove": minor
---

Render interactive prompts on stderr so they are visible under the shell wrapper, and require Node 24

The `wt` shell function captures stdout with `$(...)` to read the cd sentinel, which meant prompts drawn on stdout were swallowed — `wt clone` appeared to hang with no visible question. The captured prompt frame also broke the sentinel match, so the wrapper printed a raw `__WT_CD__/path/to/repo` line instead of changing directory.

`engines.node` moves from `>=20` to `>=24`. Node 20 is out of support, and Node 24 is the version grove is now built and tested against; installing on an older runtime fails up front with `EBADENGINE` rather than at the first unsupported API. Upgrade to Node 24 before taking this release.
