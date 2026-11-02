---
'@jakeginnivan/grove': minor
---

`grove create` now asks which GitHub user or org to create the repo under when it creates one on GitHub interactively. Owners that your registered repos already push to are listed first with a count of local repos, then the rest of your orgs, then an "Other…" entry for an owner you type. The owner you last created under is the default. `--owner` still skips the prompt, and `--github` on its own still creates under your account without asking.
