---
'@jakeginnivan/grove': minor
---

Add `grove import` and `grove create`.

`grove import <path>` adopts an existing local repo. When the repo is a plain
clone rather than the `<repo>/main` layout grove expects, it says so and offers
to move the checkout into a `main/` subfolder in place, leaving the repo's own
path unchanged. `--restructure` / `--no-restructure` decide without prompting,
and `--profile` / `--dir` can also relocate the repo under a profile directory.
A repo with linked worktrees is refused rather than silently broken.

`grove create <name>` starts a new repo at `<profile-dir>/<name>/main` with
`git init` on branch `main` and registers it, prompting for the profile when
several are configured.
