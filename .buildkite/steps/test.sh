#!/usr/bin/env bash
# Typecheck and test on one platform.
set -euo pipefail

source .buildkite/steps/toolchain.sh

# `pnpm install` is explicit here: unlike the GitHub Actions pnpm/setup
# action, nothing installs dependencies for us. --frozen-lockfile is the CI
# default but is stated outright so a drifted lockfile fails rather than
# silently resolving something new.
pnpm install --frozen-lockfile

# Integration tests shell out to git and read its config, so give the agent an
# identity rather than letting each test invent one. Agents are reused between
# builds, so this is scoped to the checkout with --local, not --global.
git config user.name "CI"
git config user.email "ci@example.com"
git config init.defaultBranch main

pnpm typecheck

# Builds first via the vitest globalSetup, then runs against the bundle.
pnpm test
