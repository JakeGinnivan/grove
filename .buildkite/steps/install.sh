#!/usr/bin/env bash
# Activates the toolchain and installs dependencies, for steps whose real work
# is done by a plugin's post-command hook.
#
# The changesets plugin deliberately knows nothing about mise or pnpm -- a
# plugin must not pick a consumer's package manager -- so providing the
# toolchain is this repo's job, and this is the command those steps run.
set -euo pipefail

source .buildkite/steps/toolchain.sh

pnpm install --frozen-lockfile
