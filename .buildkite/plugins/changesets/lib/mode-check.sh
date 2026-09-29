#!/usr/bin/env bash
# Fails a change that touches a package but adds no changeset.
#
# This defers to `changeset status --since`, which is the tool's own built-in
# check: it exits 1 with "Some packages have been changed but no changesets
# were found". That understands package boundaries, unlike diffing paths
# against a `^src/` pattern, and it stays correct in a workspace.
#
# Scope: changesets counts any tracked file outside a dot-directory as a
# package change, so `docs/`, `test/` and `README.md` need a changeset (an
# `--empty` one is fine). Changes confined to `.buildkite/` or `.github/` do
# not.
set -euo pipefail

: "${PLUGIN_DIR:?must be run through the plugin command hook}"

# On the default branch there is nothing to compare against and the merge has
# already happened, so the check has nothing to say. It runs on branch builds
# as well as PR builds -- a pipeline that builds branches reports no PR, so
# skipping whenever BUILDKITE_PULL_REQUEST is "false" would mean never running.
if [[ "$BUILDKITE_BRANCH" == "$BUILDKITE_PIPELINE_DEFAULT_BRANCH" ]]; then
  echo "On the default branch; the changeset is checked before merge."
  exit 0
fi

BASE_BRANCH="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-$BUILDKITE_PIPELINE_DEFAULT_BRANCH}"

# Buildkite clones shallow by default, so the base ref usually is not in the
# local history yet. `--since` resolves it with git, so it has to be fetched.
git fetch --no-tags origin "$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH" ||
  git fetch --no-tags origin "$BASE_BRANCH"

# The "Version Packages" commit deletes every changeset, so the gate below
# would find none and fail the release PR permanently. Exempt it by what it
# contains, never by its branch name: a branch build carries no PR metadata,
# so a name match would be an authorization check made of a string anyone can
# choose. See lib/is-version-pr.sh.
if "$PLUGIN_DIR/lib/is-version-pr.sh" "origin/$BASE_BRANCH"; then
  echo "This is a version bump; no changeset expected."
  exit 0
fi

# The exit code alone is not a safe signal. On @changesets/cli 2.31.1 the
# "nothing to release" case exits 0, but on 3.x it exits 1 -- the same code as
# the genuine "package changed with no changeset" failure. Distinguishing them
# by exit code would fail a docs-only change on 3.x.
#
# So: capture the output and decide from it.
STATUS_JSON="$PWD/changeset-status.json"
rm -f "$STATUS_JSON"
set +e
STATUS_LOG="$(npx --no-install changeset status --since "origin/$BASE_BRANCH" --output "$STATUS_JSON" 2>&1)"
set -e
echo "$STATUS_LOG"

# This message is the actual failure being gated on, in every version.
if grep -qi 'no changesets were found' <<<"$STATUS_LOG"; then
  buildkite-agent annotate --style error --context changesets <<'EOF'
**No changeset found.**

This change touches a package but adds no changeset, so it would ship silently
under the previous version number.

- **User-visible change?** Run `changeset` and commit the result.
- **Docs, tests, or a refactor that ships nothing?** Run `changeset add --empty`
  and commit that. An empty changeset satisfies this check and adds nothing to
  the changelog.

Note this is broader than a `src/`-only rule: changesets counts any tracked
file outside a dot-directory, so `docs/`, `test/` and `README.md` all need one.
Changes confined to `.buildkite/` or `.github/` do not.
EOF
  exit 1
fi

# Surface the planned bump in the build UI, so a reviewer can see what this
# change would release without reading the changeset files.
if [[ -s "$STATUS_JSON" ]]; then
  node "$PLUGIN_DIR/lib/annotate-changesets.mjs" < "$STATUS_JSON" |
    buildkite-agent annotate --style info --context changesets
else
  echo "No release planned by this change."
fi
