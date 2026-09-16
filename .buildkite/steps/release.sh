#!/usr/bin/env bash
# Either opens/updates a version PR, or publishes when the version PR lands.
#
# This replaces changesets/action, which is GitHub Actions-only. The two
# branches below are exactly what that action decides between:
#   pending changesets    -> bump versions, open the "Version Packages" PR
#   no pending changesets -> the bump already landed, so publish it
#
# The decision uses `changeset status --output`, the tool's own machine-
# readable report, rather than globbing .changeset/*.md: it distinguishes a
# real changeset from the README and config that live in that directory, and
# it reports the computed next version for the annotation below.
set -euo pipefail

source .buildkite/steps/toolchain.sh

pnpm install --frozen-lockfile

# changeset version/publish both commit and tag, so an identity is required.
git config user.name "buildkite"
git config user.email "buildkite@users.noreply.github.com"

# The agent clones with the Buildkite GitHub App, which is read-only: pushing
# with those credentials fails with "Permission to ... denied to buildkite[bot]".
# Both pushes below therefore need a token with write access, and `gh` needs
# the same one.
#
# The agents are Buildkite-hosted, so cluster secrets are not injected into the
# environment -- they are fetched explicitly. Allow an already-set GITHUB_TOKEN
# to win so the script stays runnable outside Buildkite.
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  GITHUB_TOKEN="$(buildkite-agent secret get GITHUB_TOKEN)"
  export GITHUB_TOKEN
fi
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set to push the version PR}"

# BUILDKITE_REPO may be either SSH or HTTPS; take the owner/name from it and
# push over HTTPS regardless. The URL is passed to each push rather than stored
# with `git remote set-url`, so the token never lands in .git/config where a
# later step on a reused agent could read it.
#
# REPO is the bare owner/name. The trailing `.git` has to go: it is harmless in
# a push URL but would make the API paths below 404.
REPO="${BUILDKITE_REPO#*github.com[:/]}"
REPO="${REPO%.git}"
PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}"

# On @changesets/cli 2.31.1 this exits 0 and writes the file even when there
# is nothing to release. That is NOT true on 3.x, where the empty case exits 1
# and writes no file at all — which under `set -e` would fail the release step
# on a perfectly green build. Tolerate both: a missing file means "nothing
# pending", and the exit code is deliberately not trusted either way.
rm -f "$PWD/changeset-status.json"
pnpm exec changeset status --output "$PWD/changeset-status.json" || true

if [[ -s "$PWD/changeset-status.json" ]]; then
  PENDING="$(node -e 'const s=require(process.argv[1]);console.log(s.releases.length)' "$PWD/changeset-status.json")"
else
  PENDING=0
fi

if [[ "$PENDING" -gt 0 ]]; then
  echo "--- Pending changesets; opening version PR"

  # Show what this release would be, on the build itself.
  node .buildkite/steps/annotate-changesets.mjs < changeset-status.json |
    buildkite-agent annotate --style info --context release

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

  # `gh` is not installed on the Buildkite hosted agent image, so the two calls
  # it made -- does an open PR exist for this branch, and if not open one -- go
  # through the REST API with curl, which is present.
  #
  # -f makes curl exit non-zero on an HTTP error, which `set -e` then catches;
  # without it a 401 or 422 would be parsed as if it were a PR list.
  api() {
    curl -fsS \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$@"
  }

  # The head filter needs the owner prefix, and REPO is already owner/name.
  OPEN_PRS="$(api "https://api.github.com/repos/${REPO}/pulls?state=open&head=${REPO%%/*}:${BRANCH}" |
    node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).length))')"

  if [[ "$OPEN_PRS" -gt 0 ]]; then
    echo "Version PR already open; the force-push updated it."
  else
    # node builds the JSON so the title and body are escaped properly rather
    # than interpolated into a string that a quote in a changeset could break.
    api -X POST "https://api.github.com/repos/${REPO}/pulls" \
      -d "$(node -e 'console.log(JSON.stringify({
        title: "chore: version packages",
        head: process.argv[1],
        base: process.argv[2],
        body: "Automated version bump from changesets. Merging this publishes to npm.",
      }))' "$BRANCH" "$BUILDKITE_BRANCH")" >/dev/null
    echo "Opened version PR for $BRANCH."
  fi
else
  echo "--- No pending changesets; publishing"

  # `changeset publish` is a no-op when every version is already on the
  # registry, so a main build with nothing to ship exits cleanly.
  #
  # Authentication is an NPM_TOKEN automation token, unlike the GitHub Actions
  # release which used npm trusted publishing (OIDC). npm does not support
  # Buildkite as a trusted publisher, so this is a token, and packages
  # published this way carry NO provenance attestation.
  #
  # Fetched from cluster secrets like GITHUB_TOKEN above; see that comment.
  if [[ -z "${NPM_TOKEN:-}" ]]; then
    NPM_TOKEN="$(buildkite-agent secret get NPM_TOKEN)"
    export NPM_TOKEN
  fi
  : "${NPM_TOKEN:?NPM_TOKEN must be set for publishing}"
  echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc

  pnpm release

  # Tags are created locally by `changeset publish`; push them so the GitHub
  # releases and the registry agree.
  git push --follow-tags "$PUSH_URL" "HEAD:${BUILDKITE_BRANCH}" 2>/dev/null ||
    { echo "Tag push failed (output suppressed: it contains the token)"; exit 1; }
fi
