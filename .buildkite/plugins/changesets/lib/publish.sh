#!/usr/bin/env bash
# Publishes, or stages, the already-versioned package(s), then creates the
# GitHub release.
#
# Uploaded by mode-upload.sh when no changesets are pending, which means the
# version PR has landed and the manifests carry the versions to ship.
#
# publish=stage uses `npm stage publish`: staging needs no 2FA and works with
# any token, while approving requires 2FA and so has to be done by a person
# from their own machine. That is the point -- proof-of-presence on the act
# that makes a version public, without a 2FA prompt in CI.
#
# Note that `changeset publish` has no staged mode (changesets#2025 is open),
# which is why staging calls npm directly rather than going through changesets.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/github.sh"

PUBLISH_MODE="${BUILDKITE_PLUGIN_CHANGESETS_PUBLISH:-publish}"
WANT_RELEASE="${BUILDKITE_PLUGIN_CHANGESETS_RELEASE:-true}"

# The tag is created here, so an identity is required.
git config user.name "${BUILDKITE_PLUGIN_CHANGESETS_GIT_NAME:-buildkite}"
git config user.email "${BUILDKITE_PLUGIN_CHANGESETS_GIT_EMAIL:-buildkite@users.noreply.github.com}"

if [[ -z "${NPM_TOKEN:-}" ]] && [[ "$PUBLISH_MODE" != "none" ]]; then
  NPM_TOKEN="$(buildkite-agent secret get NPM_TOKEN 2>/dev/null || true)"
  export NPM_TOKEN
fi
if [[ -n "${NPM_TOKEN:-}" ]]; then
  echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc
fi

NAME="$(node -p 'require("./package.json").name')"
VERSION="$(node -p 'require("./package.json").version')"

# Already on the registry: the version PR landed twice, or this build is a
# rerun. Nothing to do, and publishing would fail on the duplicate version.
if npm view "${NAME}@${VERSION}" version >/dev/null 2>&1; then
  echo "${NAME}@${VERSION} is already published; nothing to do."
  exit 0
fi

STAGE_ID=''

if [[ "$PUBLISH_MODE" == "stage" ]]; then
  # --json so the stage id can be read from a field rather than scraped out of
  # "+ pkg@1.2.3 (staged with id ...)". npm only sets stageId when the registry
  # returns one, so it can legitimately be absent.
  #
  # Tee rather than capture: if the output is not the JSON expected, the log
  # still shows exactly what npm said.
  STAGE_LOG="$PWD/npm-stage.json"
  npm stage publish --json 2>&1 | tee "$STAGE_LOG"

  # npm pipes through tee, so check its status, not tee's.
  if [[ "${PIPESTATUS[0]}" -ne 0 ]]; then
    echo "npm stage publish failed."
    exit 1
  fi

  # Tolerate both a missing field and unparseable output: the id only decorates
  # the instructions, and losing it must not fail a release npm has accepted.
  STAGE_ID="$(node -e '
    const fs = require("node:fs")
    try {
      const out = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      process.stdout.write(out.stageId ?? "")
    } catch {
      process.stdout.write("")
    }
  ' "$STAGE_LOG")"
else
  # `changeset publish` handles workspaces, tags each published package and
  # skips anything already on the registry, so it is preferred over npm here.
  npx --no-install changeset publish
fi

# Tag at release time: the version is fixed by the manifest whether or not a
# stage is later approved. A rejected stage leaves a tag pointing at a version
# that never shipped -- the tradeoff for tagging the commit that was built.
TAG="v${VERSION}"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Tag ${TAG} already exists locally."
else
  git tag -a "${TAG}" -m "${TAG}"
fi

git push --follow-tags "$PUSH_URL" "HEAD:${BUILDKITE_BRANCH}" 2>/dev/null ||
  { echo "Tag push failed (output suppressed: it contains the token)"; exit 1; }

if [[ "$WANT_RELEASE" != "false" ]]; then
  "$HERE/create-release.sh" "$TAG" "$VERSION" "$STAGE_ID"
fi

if [[ "$PUBLISH_MODE" == "stage" ]]; then
  {
    echo "**\`${NAME}@${VERSION}\` is staged, not published.**"
    echo
    echo "Approving requires 2FA, so it has to happen from your machine:"
    echo
    echo '```'
    if [[ -n "$STAGE_ID" ]]; then
      echo "npm stage view ${STAGE_ID}       # inspect before approving"
      echo "npm stage approve ${STAGE_ID}    # publishes it"
    else
      echo "npm stage list ${NAME}"
      echo "npm stage view <stage-id>       # inspect before approving"
      echo "npm stage approve <stage-id>    # publishes it"
    fi
    echo '```'
  } | buildkite-agent annotate --style warning --context release
fi
