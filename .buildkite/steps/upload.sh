#!/usr/bin/env bash
# Chooses the pipeline for this build and uploads it.
#
# BUILDKITE_PULL_REQUEST is the literal string "false" on a non-PR build, not
# an empty value — quoting and comparing against "false" is deliberate.
set -euo pipefail

buildkite-agent pipeline upload .buildkite/ci.yml

# Release only from the tip of the default branch, and never from a PR build
# targeting it. Both conditions matter: a PR build also reports a branch.
if [[ "$BUILDKITE_BRANCH" != "$BUILDKITE_PIPELINE_DEFAULT_BRANCH" || "$BUILDKITE_PULL_REQUEST" != "false" ]]; then
  exit 0
fi

# Decide *here* which half of the release this build is, so the step is named
# for what it does before it runs. release.sh used to make this decision at
# runtime, which meant one ambiguous step whose meaning you learned from the
# log.
#
# The cost is a toolchain and install in the upload step, which previously did
# nothing but two `pipeline upload` calls.
source .buildkite/steps/toolchain.sh
pnpm install --frozen-lockfile

# On @changesets/cli 2.31.1 this exits 0 and writes the file even when there
# is nothing to release. That is NOT true on 3.x, where the empty case exits 1
# and writes no file at all — which under `set -e` would fail the upload on a
# perfectly green build. Tolerate both: a missing file means "nothing
# pending", and the exit code is deliberately not trusted either way.
rm -f "$PWD/changeset-status.json"
pnpm exec changeset status --output "$PWD/changeset-status.json" || true

if [[ -s "$PWD/changeset-status.json" ]]; then
  PENDING="$(node -e 'const s=require(process.argv[1]);console.log(s.releases.length)' "$PWD/changeset-status.json")"
else
  PENDING=0
fi

if [[ "$PENDING" -gt 0 ]]; then
  echo "Pending changesets: this build opens the version PR."
  buildkite-agent pipeline upload .buildkite/version.yml
else
  echo "No pending changesets: this build stages the release."
  buildkite-agent pipeline upload .buildkite/publish.yml
fi
