#!/usr/bin/env bash
# Fails a PR that changes a package but adds no changeset.
#
# This defers to `changeset status --since`, which is the tool's own built-in
# check: it exits 1 with "Some packages have been changed but no changesets
# were found". That understands package boundaries, unlike diffing paths
# against a `^src/` pattern, and it stays correct if the repo ever gains a
# second package.
#
# Scope is wider than the `^src/|^package\.json$` rule this replaces: any
# tracked file outside a dot-directory counts as a package change, so `docs/`,
# `test/` and the build config need a changeset (an `--empty` one is fine).
# Changes confined to `.buildkite/`, `.github/` or `.vscode/` do not.
set -euo pipefail

source .buildkite/steps/toolchain.sh

# Only meaningful on a PR: there is no base to compare against otherwise, and
# a main build is past the point where adding a changeset would help.
if [[ "${BUILDKITE_PULL_REQUEST:-false}" == "false" ]]; then
  echo "Not a pull request; the changeset is checked on the PR."
  exit 0
fi

pnpm install --frozen-lockfile

BASE_BRANCH="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-$BUILDKITE_PIPELINE_DEFAULT_BRANCH}"

# Buildkite clones shallow by default, so the base ref usually is not in the
# local history yet. `--since` resolves it with git, so it has to be fetched.
git fetch --no-tags origin "$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH" || \
  git fetch --no-tags origin "$BASE_BRANCH"

# Note: --since only sees *committed* changesets, which is what we want — an
# uncommitted file could not have reached the PR anyway.
#
# The exit code alone is not a safe signal. On @changesets/cli 2.31.1 the
# "nothing to release" case exits 0, but on 3.x it exits 1 — the same code as
# the genuine "package changed with no changeset" failure. Distinguishing them
# by exit code would fail a docs-only PR on 3.x.
#
# So: capture the output and decide from it. A missing/empty file means the
# command bailed, and the log tells us which of the two cases it was.
rm -f "$PWD/changeset-status.json"
set +e
STATUS_LOG="$(pnpm exec changeset status --since "origin/$BASE_BRANCH" --output "$PWD/changeset-status.json" 2>&1)"
set -e
echo "$STATUS_LOG"

# This message is the actual failure we are gating on, in every version.
if grep -qi 'no changesets were found' <<<"$STATUS_LOG"; then
  NEEDS_CHANGESET=true
else
  NEEDS_CHANGESET=false
fi

# Surface the planned bump in the build UI, so the reviewer can see what this
# PR would release without reading the changeset files.
if [[ "$NEEDS_CHANGESET" == "false" ]]; then
  if [[ -s "$PWD/changeset-status.json" ]]; then
    node .buildkite/steps/annotate-changesets.mjs < changeset-status.json |
      buildkite-agent annotate --style info --context changesets
  else
    echo "No release planned by this PR."
  fi
else
  buildkite-agent annotate --style error --context changesets <<'EOF'
**No changeset found.**

This PR changes the package but adds no changeset, so it would ship silently
under the previous version number.

- **User-visible change?** Run `pnpm changeset` and commit the result.
- **Docs, tests, or a refactor that ships nothing?** Run
  `pnpm changeset add --empty` and commit that.

Note this is broader than a `src/`-only rule: changesets counts any tracked
file outside a dot-directory, so `docs/`, `test/` and the build config all
need one. Changes confined to `.buildkite/`, `.github/` or `.vscode/` do not.
EOF
  exit 1
fi
