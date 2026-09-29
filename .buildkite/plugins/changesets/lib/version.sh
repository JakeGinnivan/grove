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

# The head filter needs the owner prefix, and REPO is already owner/name.
OPEN_PRS="$(github_api "https://api.github.com/repos/${REPO}/pulls?state=open&head=${REPO%%/*}:${BRANCH}" |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).length))')"

if [[ "$OPEN_PRS" -gt 0 ]]; then
  echo "Version PR already open; the force-push updated it."
else
  # node builds the JSON so the title and body are escaped properly rather than
  # interpolated into a string that a quote in a changeset could break.
  github_api -X POST "https://api.github.com/repos/${REPO}/pulls" \
    -d "$(node -e 'console.log(JSON.stringify({
      title: "chore: version packages",
      head: process.argv[1],
      base: process.argv[2],
      body: "Automated version bump from changesets. Merging this releases the versions listed above.",
    }))' "$BRANCH" "$BUILDKITE_BRANCH")" >/dev/null
  echo "Opened version PR for $BRANCH."
fi
