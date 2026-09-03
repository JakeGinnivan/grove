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
# the same one. Set GITHUB_TOKEN as a Buildkite secret.
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set to push the version PR}"

# BUILDKITE_REPO may be either SSH or HTTPS; take the owner/name from it and
# push over HTTPS regardless. The URL is passed to each push rather than stored
# with `git remote set-url`, so the token never lands in .git/config where a
# later step on a reused agent could read it.
PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${BUILDKITE_REPO#*github.com[:/]}"

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

  # gh reads GITHUB_TOKEN from the environment; set it as a Buildkite secret.
  if gh pr view "$BRANCH" --json number >/dev/null 2>&1; then
    echo "Version PR already open; the force-push updated it."
  else
    gh pr create \
      --base "$BUILDKITE_BRANCH" \
      --head "$BRANCH" \
      --title "chore: version packages" \
      --body "Automated version bump from changesets. Merging this publishes to npm."
  fi
else
  echo "--- No pending changesets; publishing"

  # `changeset publish` is a no-op when every version is already on the
  # registry, so a main build with nothing to ship exits cleanly.
  #
  # Authentication is an NPM_TOKEN classic automation token, unlike the
  # GitHub Actions release which used npm trusted publishing (OIDC). npm does
  # not support Buildkite as a trusted publisher, so this is a token, and
  # packages published this way carry NO provenance attestation.
  : "${NPM_TOKEN:?NPM_TOKEN must be set for publishing}"
  echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc

  pnpm release

  # Tags are created locally by `changeset publish`; push them so the GitHub
  # releases and the registry agree.
  git push --follow-tags "$PUSH_URL" "HEAD:${BUILDKITE_BRANCH}" 2>/dev/null ||
    { echo "Tag push failed (output suppressed: it contains the token)"; exit 1; }
fi
