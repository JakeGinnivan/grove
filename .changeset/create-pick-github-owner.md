---
'@jakeginnivan/grove': minor
---

`grove create` now asks which GitHub user or org to create the repo under when it creates one on GitHub interactively. Your own account is listed first and is the default. Next come the orgs you have used, most recently created-under first, then those your registered repos push to. The rest of your orgs follow, then an "Other…" entry for an owner you type. `--owner` still skips the prompt, and `--github` on its own still creates under your account without asking.
