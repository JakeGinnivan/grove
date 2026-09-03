#!/usr/bin/env bash
# Chooses the pipeline for this build and uploads it.
#
# BUILDKITE_PULL_REQUEST is the literal string "false" on a non-PR build, not
# an empty value — quoting and comparing against "false" is deliberate.
set -euo pipefail

buildkite-agent pipeline upload .buildkite/ci.yml

# Release only from the tip of the default branch, and never from a PR build
# targeting it. Both conditions matter: a PR build also reports a branch.
if [[ "$BUILDKITE_BRANCH" == "$BUILDKITE_PIPELINE_DEFAULT_BRANCH" && "$BUILDKITE_PULL_REQUEST" == "false" ]]; then
  buildkite-agent pipeline upload .buildkite/release.yml
fi
