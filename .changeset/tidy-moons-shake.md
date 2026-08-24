---
'@jakeginnivan/grove': patch
---

Render interactive prompts on stderr so they are visible under the shell wrapper

The `wt` shell function captures stdout with `$(...)` to read the cd sentinel, which meant prompts drawn on stdout were swallowed — `wt clone` appeared to hang with no visible question. The captured prompt frame also broke the sentinel match, so the wrapper printed a raw `__WT_CD__/path/to/repo` line instead of changing directory.
