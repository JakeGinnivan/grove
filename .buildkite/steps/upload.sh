#!/usr/bin/env bash
# Uploads the steps that run on every build.
#
# The release half is decided by the changesets plugin attached to this same
# step, which is why nothing here looks at the branch any more: the plugin does
# that itself, in its post-command hook, after this script has finished.
set -euo pipefail

buildkite-agent pipeline upload .buildkite/ci.yml

# Dependencies are installed for that hook: it runs `changeset status` to work
# out whether this build opens the version PR or stages the release, so it
# needs the CLI this installs. The toolchain is already on PATH, activated by
# .buildkite/hooks/post-checkout so that the hook gets it too.
pnpm install --frozen-lockfile
