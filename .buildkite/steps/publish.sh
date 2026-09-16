#!/usr/bin/env bash
# Stages the already-versioned package on npm, for a human to approve.
#
# upload.sh uploads this instead of version.sh when no changesets are pending,
# which means the version PR has landed and package.json carries the version
# to ship.
#
# Staged rather than published outright: `npm stage publish` needs no 2FA and
# works with any token, while approving requires 2FA and so has to be done by
# a person from their own machine. That is the point -- proof-of-presence on
# the act that makes a version public, without a 2FA prompt in CI. See
# `npm help stage`.
set -euo pipefail

source .buildkite/steps/toolchain.sh
source .buildkite/steps/github.sh

pnpm install --frozen-lockfile

# The tag is created here, so an identity is required.
git config user.name "buildkite"
git config user.email "buildkite@users.noreply.github.com"

if [[ -z "${NPM_TOKEN:-}" ]]; then
  NPM_TOKEN="$(buildkite-agent secret get NPM_TOKEN)"
  export NPM_TOKEN
fi
: "${NPM_TOKEN:?NPM_TOKEN must be set for staging}"
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc

NAME="$(node -p 'require("./package.json").name')"
VERSION="$(node -p 'require("./package.json").version')"

# Already on the registry: the version PR landed twice, or this build is a
# rerun. Nothing to stage, and staging would fail on the duplicate version.
if npm view "${NAME}@${VERSION}" version >/dev/null 2>&1; then
  echo "${NAME}@${VERSION} is already published; nothing to stage."
  exit 0
fi

pnpm build

# Tee rather than capture: the stage id is in this output, and if the format
# is not what we expect the log still shows exactly what npm said.
STAGE_LOG="$PWD/npm-stage.log"
npm stage publish 2>&1 | tee "$STAGE_LOG"

# `npm stage publish` pipes through tee, so check its status, not tee's.
if [[ "${PIPESTATUS[0]}" -ne 0 ]]; then
  echo "npm stage publish failed."
  exit 1
fi

# Tag at stage time, as the released version is fixed by package.json whether
# or not the stage is later approved. A rejected stage leaves a tag pointing
# at a version that never shipped -- the tradeoff for tagging the commit that
# was actually built.
TAG="v${VERSION}"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Tag ${TAG} already exists locally."
else
  git tag -a "${TAG}" -m "${TAG}"
fi

git push --follow-tags "$PUSH_URL" "HEAD:${BUILDKITE_BRANCH}" 2>/dev/null ||
  { echo "Tag push failed (output suppressed: it contains the token)"; exit 1; }

# Surface the approval step on the build itself. The stage id is in the log
# above; `npm stage list` is the reliable way to get it, so the annotation
# gives both rather than a parsed id that could silently come out empty.
{
  echo "**\`${NAME}@${VERSION}\` is staged, not published.**"
  echo
  echo "Approving requires 2FA, so it has to happen from your machine:"
  echo
  echo '```'
  echo "npm stage list ${NAME}"
  echo "npm stage view <stage-id>       # inspect before approving"
  echo "npm stage approve <stage-id>    # publishes it"
  echo '```'
  echo
  echo "\`npm stage publish\` said:"
  echo
  echo '```'
  cat "$STAGE_LOG"
  echo '```'
} | buildkite-agent annotate --style warning --context release
