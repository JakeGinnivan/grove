---
'@jakeginnivan/grove': minor
---

Deprecate `grove repos add` in favour of `grove import`.

`repos add` now forwards to `grove import --no-restructure`, which registers
the repo exactly as it did before, and prints a deprecation warning (carried in
the `deprecated` field under `--json`). It is hidden from help and will be
removed in v1. Use `grove import` instead, which can also fix a layout that is
not `<repo>/main`.
