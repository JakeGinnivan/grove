---
'@jakeginnivan/grove': minor
---

`grove create` can now create the repo on GitHub.

When the GitHub CLI is installed and logged in, `create` offers to create the
repo on GitHub and wire it up as `origin`, asking for visibility (defaulting to
private). `--github` / `--no-github` decide without prompting, `--visibility`
picks private/public/internal, and `--owner` creates under an org. Nothing is
pushed, since a freshly created repo has no commits. A GitHub failure never
costs you the local repo, which is created and registered first.

Set `GROVE_NO_GITHUB=1` to stop grove invoking `gh` at all.
