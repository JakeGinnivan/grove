#!/usr/bin/env bash
# GITHUB_TOKEN, and the two things built from it: a push URL and an API helper.
#
# Must be *sourced*, not executed.
#
#   source .buildkite/steps/github.sh

# The agent clones with the Buildkite GitHub App, which is read-only: pushing
# with those credentials fails with "Permission to ... denied to buildkite[bot]".
# Pushes therefore need a token with write access.
#
# The agents are Buildkite-hosted, so cluster secrets are not injected into the
# environment -- they are fetched explicitly. Allow an already-set GITHUB_TOKEN
# to win so the scripts stay runnable outside Buildkite.
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  GITHUB_TOKEN="$(buildkite-agent secret get GITHUB_TOKEN)"
  export GITHUB_TOKEN
fi
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set to push and open the version PR}"

# BUILDKITE_REPO may be either SSH or HTTPS; take the owner/name from it and
# push over HTTPS regardless. The URL is passed to each push rather than stored
# with `git remote set-url`, so the token never lands in .git/config where a
# later step on a reused agent could read it.
#
# REPO is the bare owner/name. The trailing `.git` has to go: it is harmless in
# a push URL but would make the API paths 404.
REPO="${BUILDKITE_REPO#*github.com[:/]}"
REPO="${REPO%.git}"
PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}"
export REPO PUSH_URL

# `gh` is not installed on the Buildkite hosted agent image, so API calls go
# through curl, which is present.
#
# -f makes curl exit non-zero on an HTTP error, which `set -e` then catches;
# without it a 401 body would be parsed as if it were a successful response.
github_api() {
  curl -fsS \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}
