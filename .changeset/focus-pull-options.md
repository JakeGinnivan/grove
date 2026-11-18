---
"@jakeginnivan/grove": patch
---

`grove focus pull` now receives its `--discard`, `--repo` and `--setup` options. `grove focus` defines the same options and took them first, so `grove focus pull --discard` still failed with `focus_dirty`.
