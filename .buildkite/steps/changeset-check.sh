#!/usr/bin/env bash
# Fails a change that touches the package but adds no changeset.
#
# This defers to `changeset status --since`, which is the tool's own built-in
# check: it exits 1 with "Some packages have been changed but no changesets
# were found". That understands package boundaries, unlike diffing paths
# against a `^src/` pattern, and it stays correct if the repo ever gains a
# second package.
#
# Scope: changesets counts any tracked file outside a dot-directory as a
# package change, so `docs/`, `test/` and `README.md` need a changeset (an
# `--empty` one is fine). Changes confined to `.buildkite/`, `.github/` or
# `.vscode/` do not.
set -euo pipefail

source .buildkite/steps/toolchain.sh

# Runs on branch builds as well as PR builds. It used to skip whenever
# BUILDKITE_PULL_REQUEST was "false", which meant it never ran at all: this
# pipeline builds branches, those builds report no PR, and so every branch
# build printed "checked on the PR" and exited 0. The check was decorative.
#
# On the default branch there is nothing to compare against and the merge has
# already happened, so there it really does have nothing to say.
if [[ "$BUILDKITE_BRANCH" == "$BUILDKITE_PIPELINE_DEFAULT_BRANCH" ]]; then
  echo "On the default branch; the changeset is checked before merge."
  exit 0
fi

pnpm install --frozen-lockfile

BASE_BRANCH="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-$BUILDKITE_PIPELINE_DEFAULT_BRANCH}"

# Buildkite clones shallow by default, so the base ref usually is not in the
# local history yet. `--since` resolves it with git, so it has to be fetched.
git fetch --no-tags origin "$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH" || \
  git fetch --no-tags origin "$BASE_BRANCH"

# The "Version Packages" commit deletes every changeset, so the gate below
# would find none and fail the release PR permanently. Exempt it by what it
# contains, never by its branch name: a branch build carries no PR metadata,
# so a name match would be an authorization check made of a string anyone can
# choose. See is-version-pr.sh.
if .buildkite/steps/is-version-pr.sh "origin/$BASE_BRANCH"; then
  echo "This is a version bump; no changeset expected."
  exit 0
fi

# Note: --since only sees *committed* changesets, which is what we want — an
# uncommitted file could not have reached the branch anyway.
#
# The exit code alone is not a safe signal. On @changesets/cli 2.31.1 the
# "nothing to release" case exits 0, but on 3.x it exits 1 — the same code as
# the genuine "package changed with no changeset" failure. Distinguishing them
# by exit code would fail a docs-only change on 3.x.
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
# change would release without reading the changeset files.
if [[ "$NEEDS_CHANGESET" == "false" ]]; then
  if [[ -s "$PWD/changeset-status.json" ]]; then
    node .buildkite/steps/annotate-changesets.mjs < changeset-status.json |
      buildkite-agent annotate --style info --context changesets
  else
    echo "No release planned by this change."
  fi
else
  buildkite-agent annotate --style error --context changesets <<'EOF'
**No changeset found.**

This change touches the package but adds no changeset, so it would ship
silently under the previous version number.

- **User-visible change?** Run `pnpm changeset` and commit the result.
- **Docs, tests, or a refactor that ships nothing?** Run
  `pnpm changeset add --empty` and commit that. An empty changeset satisfies
  this check and adds nothing to the changelog.

Note this is broader than a `src/`-only rule: changesets counts any tracked
file outside a dot-directory, so `docs/`, `test/` and `README.md` all need
one. Changes confined to `.buildkite/`, `.github/` or `.vscode/` do not.
EOF
  exit 1
fi
