---
'@jakeginnivan/grove': patch
---

Fix branch listing on git older than 2.42. `for-each-ref --exclude` was added
in git 2.42, and on older versions the whole command failed, which surfaced as
an empty branch list in `grove checkout` and shell completion rather than an
error. The `<remote>/HEAD` ref is now filtered in code instead.
