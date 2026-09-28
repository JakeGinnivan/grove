#!/usr/bin/env bash
# Uploads the steps that run on every build.
#
# The release half is decided by the changesets plugin attached to this same
# step, which is why nothing here looks at the branch any more: the plugin does
# that itself, in its post-command hook, after this script has finished.
set -euo pipefail

buildkite-agent pipeline upload .buildkite/ci.yml

# The toolchain is installed for that hook: it runs `changeset status` to work
# out whether this build opens the version PR or stages the release, so it
# needs the CLI this installs.
source .buildkite/steps/toolchain.sh
pnpm install --frozen-lockfile
