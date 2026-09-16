#!/usr/bin/env bash
# Exits 0 if the diff against the base is *exactly* a changesets version bump.
#
# The changeset gate has to let the "Version Packages" commit through: that
# commit deletes every changeset, so the gate would otherwise find none and
# fail the release PR permanently.
#
# Deciding that by branch name (`changeset-release/*`) would be an authorization
# check made out of a string anyone can choose. Branch builds carry no PR
# metadata at all -- BUILDKITE_PULL_REQUEST is "false" and the API reports
# pull_request: None -- so there is nothing on a branch build that proves who
# pushed it. Today `build_pull_request_forks` is off, but the exemption would
# become a hole the moment that changes.
#
# So this checks the *content* instead. A version bump has a shape that cannot
# be forged without actually being one:
#   - only package.json, CHANGELOG.md and deleted .changeset/*.md files
#   - package.json changed on the version line and nothing else
#
# Usage: is-version-pr.sh <base-ref>
set -euo pipefail

BASE="$1"

FILES="$(git diff --name-status "$BASE"...HEAD)"

# An empty diff is not a version bump.
[[ -n "$FILES" ]] || exit 1

while IFS=$'\t' read -r STATUS PATH_ONE _; do
  [[ -n "$STATUS" ]] || continue
  case "$STATUS:$PATH_ONE" in
    M:package.json | M:CHANGELOG.md) ;;
    D:.changeset/*.md) ;;
    # Anything else at all means this is a normal change that needs a changeset.
    *) exit 1 ;;
  esac
done <<<"$FILES"

# A version bump always deletes at least one changeset, rewrites the changelog
# AND bumps package.json. All three are required: without the package.json
# clause, a change that merely deletes the changesets and appends to the
# changelog would be waved through, which is precisely the bypass this script
# exists to prevent.
grep -q '^D'$'\t''\.changeset/.*\.md$' <<<"$FILES" || exit 1
grep -q '^M'$'\t''CHANGELOG\.md$' <<<"$FILES" || exit 1
grep -q '^M'$'\t''package\.json$' <<<"$FILES" || exit 1

# package.json may only differ on the version line. `changeset version` touches
# nothing else there for a single-package repo; a dependency or script edit
# smuggled into the same commit must still need a changeset.
CHANGED_KEYS="$(git diff -U0 "$BASE"...HEAD -- package.json |
  grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' |
  sed -E 's/^[+-][[:space:]]*"([^"]+)".*/\1/' | sort -u)"
[[ "$CHANGED_KEYS" == "version" ]] || exit 1

exit 0
