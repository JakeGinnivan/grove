---
"@jakeginnivan/grove": minor
---

`grove setup` is now a settings menu: it lists every setting with its current value, edits the one you pick, and returns to the list until you save. It also covers the trash setting and the default profile, which setup could not change before. Flags (now including `--trash`/`--no-trash`) set only what they name and never prompt, and setup no longer writes `GROVE_*` environment overrides into the config file.
