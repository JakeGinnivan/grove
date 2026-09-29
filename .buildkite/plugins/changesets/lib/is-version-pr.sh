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
# pushed it. If a pipeline ever builds fork PRs, a name match becomes a hole.
#
# So this checks the *content* instead. A version bump has a shape that cannot
# be forged without actually being one:
#   - only package.json, CHANGELOG.md and deleted .changeset/*.md files,
#     at any depth so a monorepo's packages/*/package.json counts
#   - every changed package.json differs only on `version`, or on a dependency
#     range that `changeset version` rewrote for an internal package
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
    # Root or nested, so a workspace layout is accepted.
    M:package.json | M:*/package.json) ;;
    M:CHANGELOG.md | M:*/CHANGELOG.md) ;;
    # A newly released package has no changelog until its first release.
    A:CHANGELOG.md | A:*/CHANGELOG.md) ;;
    D:.changeset/*.md) ;;
    # Anything else at all means this is a normal change that needs a changeset.
    *) exit 1 ;;
  esac
done <<<"$FILES"

# A version bump always deletes at least one changeset, writes a changelog AND
# bumps a package.json. All three are required: without the package.json
# clause, a change that merely deletes the changesets and appends to the
# changelog would be waved through, which is precisely the bypass this script
# exists to prevent.
grep -qE '^D'$'\t''\.changeset/.*\.md$' <<<"$FILES" || exit 1
grep -qE '^[MA]'$'\t''(.*/)?CHANGELOG\.md$' <<<"$FILES" || exit 1
grep -qE '^M'$'\t''(.*/)?package\.json$' <<<"$FILES" || exit 1

# Each package.json may only differ on its version, or on a dependency range
# that was rewritten because an internal package it depends on was bumped. A
# script or dependency edit smuggled into the same commit must still need a
# changeset.
#
# The comparison is done on the parsed objects, not the diff text: git emits no
# function context in hunk headers for JSON, so there is no reliable way to
# tell from a diff line whether `"foo": "1.2.3"` is a top-level field or a
# dependency range.
#
# Files are checked one at a time -- pooling them would let an edit to one
# package.json be excused by a legitimate version line in another.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/is-version-pr.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

while IFS= read -r PKG; do
  [[ -n "$PKG" ]] || continue

  # A manifest added by this change has no previous side; compare against an
  # empty object so a brand-new package is judged on its own contents.
  if git cat-file -e "$BASE:$PKG" 2>/dev/null; then
    git show "$BASE:$PKG" > "$SCRATCH/old.json"
  else
    echo '{}' > "$SCRATCH/old.json"
  fi
  git show "HEAD:$PKG" > "$SCRATCH/new.json"

  node "$HERE/changed-manifest-keys.mjs" "$SCRATCH/old.json" "$SCRATCH/new.json" || exit 1
done < <(git diff --name-only "$BASE"...HEAD -- '*package.json')

exit 0
