#!/usr/bin/env bash
# Opens or updates the "Version Packages" PR.
#
# upload.sh decides between this and publish.sh by running `changeset status`
# at upload time, so the build page names which one is happening before it
# runs. This script is only uploaded when changesets are pending.
set -euo pipefail

source .buildkite/steps/toolchain.sh
source .buildkite/steps/github.sh

pnpm install --frozen-lockfile

# changeset version commits, so an identity is required.
git config user.name "buildkite"
git config user.email "buildkite@users.noreply.github.com"

# Recomputed here rather than passed from upload.sh: the status file is small,
# the command is fast, and a step that reads its own inputs is easier to rerun.
rm -f "$PWD/changeset-status.json"
pnpm exec changeset status --output "$PWD/changeset-status.json" || true

# Show what this release would be, on the build itself.
if [[ -s "$PWD/changeset-status.json" ]]; then
  node .buildkite/steps/annotate-changesets.mjs < changeset-status.json |
    buildkite-agent annotate --style info --context release
fi

pnpm changeset version

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
  # node builds the JSON so the title and body are escaped properly rather
  # than interpolated into a string that a quote in a changeset could break.
  github_api -X POST "https://api.github.com/repos/${REPO}/pulls" \
    -d "$(node -e 'console.log(JSON.stringify({
      title: "chore: version packages",
      head: process.argv[1],
      base: process.argv[2],
      body: "Automated version bump from changesets. Merging this stages the release on npm for approval.",
    }))' "$BRANCH" "$BUILDKITE_BRANCH")" >/dev/null
  echo "Opened version PR for $BRANCH."
fi
