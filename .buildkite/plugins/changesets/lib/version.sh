#!/usr/bin/env bash
# Opens or updates the "Version Packages" PR.
#
# Uploaded by mode-upload.sh when changesets are pending, so the build page
# names which half of the release is happening before it runs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/github.sh"

# `changeset version` commits, so an identity is required.
git config user.name "${BUILDKITE_PLUGIN_CHANGESETS_GIT_NAME:-buildkite}"
git config user.email "${BUILDKITE_PLUGIN_CHANGESETS_GIT_EMAIL:-buildkite@users.noreply.github.com}"

# Recomputed here rather than passed from the upload step: the status file is
# small, the command is fast, and a step that reads its own inputs is easier to
# rerun.
STATUS_JSON="$PWD/changeset-status.json"
rm -f "$STATUS_JSON"
npx --no-install changeset status --output "$STATUS_JSON" || true

# Show what this release would be, on the build itself.
if [[ -s "$STATUS_JSON" ]]; then
  node "$HERE/annotate-changesets.mjs" < "$STATUS_JSON" |
    buildkite-agent annotate --style info --context release
fi

npx --no-install changeset version

# Nothing to do if `changeset version` produced no diff.
if git diff --quiet; then
  echo "Versioning produced no changes."
  exit 0
fi

BRANCH="changeset-release/${BUILDKITE_BRANCH}"
git checkout -B "$BRANCH"
git add -A
git commit -m "chore: version packages"

# --force is safe and required here: this branch is machine-owned and is
# rewritten from scratch on every release build. It is never a shared branch.
#
# 2>/dev/null: a push failure echoes the remote URL, which carries the token.
git push --force "$PUSH_URL" "$BRANCH" 2>/dev/null ||
  { echo "Push of $BRANCH failed (output suppressed: it contains the token)"; exit 1; }

TITLE="Publish Release"
VERSION="$(node -p 'require("./package.json").version')"

if [[ "${BUILDKITE_PLUGIN_CHANGESETS_PUBLISH:-publish}" == "stage" ]]; then
  MERGE_NOTE="Merging this stages \`${VERSION}\` on npm for approval."
else
  MERGE_NOTE="Merging this publishes \`${VERSION}\` to npm."
fi

# The body is the same changelog section the GitHub release will carry, so the
# PR shows exactly what is about to ship.
if ENTRY="$(node "$HERE/changelog-entry.mjs" "$VERSION")"; then
  BODY="$(printf '%s\n\n## %s\n\n%s' "$MERGE_NOTE" "$VERSION" "$ENTRY")"
else
  BODY="$MERGE_NOTE"
fi

# node builds the JSON so the title and body are escaped properly rather than
# interpolated into a string that a quote in a changeset could break.
pr_json() {
  node -e 'const [title, body, base, head] = process.argv.slice(1)
    console.log(JSON.stringify({ title, body, base, ...(head && { head }) }))' "$TITLE" "$BODY" "$BUILDKITE_BRANCH" "$@"
}

# The head filter needs the owner prefix, and REPO is already owner/name.
OPEN_PR="$(github_api "https://api.github.com/repos/${REPO}/pulls?state=open&head=${REPO%%/*}:${BRANCH}" |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s)[0]?.number ?? ""))')"

if [[ -n "$OPEN_PR" ]]; then
  # The force-push updated the commits; the title and body still describe the
  # previous set of changesets until they are rewritten too.
  github_api -X PATCH "https://api.github.com/repos/${REPO}/pulls/${OPEN_PR}" -d "$(pr_json)" >/dev/null
  echo "Updated version PR #${OPEN_PR}."
else
  github_api -X POST "https://api.github.com/repos/${REPO}/pulls" -d "$(pr_json "$BRANCH")" >/dev/null
  echo "Opened version PR for $BRANCH."
fi
