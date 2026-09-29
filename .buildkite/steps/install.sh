#!/usr/bin/env bash
# Installs dependencies, for steps whose real work is done by a plugin's
# post-command hook.
#
# The changesets plugin deliberately knows nothing about mise or pnpm -- a
# plugin must not pick a consumer's package manager -- so providing the
# toolchain is this repo's job. The toolchain itself is activated by
# .buildkite/hooks/post-checkout rather than here: PATH set in this script
# would not reach the plugin's hook.
set -euo pipefail

pnpm install --frozen-lockfile
