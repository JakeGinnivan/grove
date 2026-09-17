#!/usr/bin/env bash
# Creates the GitHub release for a staged version.
#
# changesets/action used to do this, and when this repo moved to Buildkite in
# c2304ff the releases stopped: v0.2.0 through v0.3.0 exist, v0.3.2 does not.
# This restores it.
#
# Usage: create-release.sh <tag> <version> <stage-id-or-empty>
#
# Must be run after github.sh is sourced: it uses github_api and REPO.
set -euo pipefail

TAG="$1"
VERSION="$2"
STAGE_ID="${3:-}"

# The release is created at stage time, matching when the tag is pushed. Both
# therefore describe a version that a rejected stage would leave unpublished --
# the same tradeoff already accepted for tags, and the reason the body says
# outright that the version is staged rather than live.
#
# Not a draft: the point of the release is that merging the version PR delivers
# a notification carrying the approval instructions. A draft notifies nobody.
if github_api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" >/dev/null 2>&1; then
  echo "Release ${TAG} already exists; leaving it alone."
  exit 0
fi

if ! BODY="$(node .buildkite/steps/changelog-entry.mjs "$VERSION")"; then
  # A release with no notes is worse than none: it would have to be edited by
  # hand anyway, and its existence would suppress the retry above.
  echo "No changelog entry for ${VERSION}; skipping the release."
  exit 0
fi

# Approving is a separate, 2FA-gated act, so the release says how to do it.
# `npm stage approve` works for whoever is logged in and prompts for their own
# 2FA, which is why it leads; the settings URL is per-account, so it is offered
# as a convenience rather than the instruction.
if [[ -n "$STAGE_ID" ]]; then
  APPROVE_CMDS=$'npm stage view '"${STAGE_ID}"$'       # inspect first\nnpm stage approve '"${STAGE_ID}"
else
  # publish.js only prints an id when the registry returns one, so this is a
  # real case rather than defensive padding.
  APPROVE_CMDS=$'npm stage list\nnpm stage approve <stage-id>'
fi

NOTES="$(cat <<EOF
${BODY}

---

**This version is staged on npm, not published.** Approving it requires 2FA:

\`\`\`
${APPROVE_CMDS}
\`\`\`

Or approve it in the browser from the [staged packages](https://www.npmjs.com/settings/jakeginnivan/staged-packages)
tab (that page is per-account, so it only works for \`jakeginnivan\`).
EOF
)"

# node builds the JSON so a backtick, quote or newline in the changelog cannot
# break out of the payload -- the same reason version.sh builds its PR body
# this way.
github_api -X POST "https://api.github.com/repos/${REPO}/releases" \
  -d "$(node -e 'console.log(JSON.stringify({
    tag_name: process.argv[1],
    name: process.argv[1],
    body: process.argv[2],
    // A prerelease is any version carrying a prerelease identifier, which is
    // exactly what a hyphen means in semver. Same test changesets/action used.
    prerelease: process.argv[3].includes("-"),
  }))' "$TAG" "$NOTES" "$VERSION")" >/dev/null

echo "Created release ${TAG}."
