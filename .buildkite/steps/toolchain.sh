#!/usr/bin/env bash
# Installs and activates the toolchain from mise.toml (node 24, pnpm 11.23.0).
#
# Must be *sourced*, not executed: each Buildkite command step is a fresh
# shell, and there is no $GITHUB_PATH equivalent to persist PATH between
# steps. Activating in the current shell is the whole point.
#
#   source .buildkite/steps/toolchain.sh
set -euo pipefail

# The installer is idempotent, so a warm agent re-running it is cheap. Agents
# are often long-lived and may already have mise from a previous build.
if ! command -v mise >/dev/null 2>&1; then
  export MISE_INSTALL_PATH="$HOME/.local/bin/mise"
  curl -fsSL https://mise.run | sh
fi

export PATH="$HOME/.local/bin:$PATH"

# Shims rather than `mise activate`: activate hooks the interactive prompt,
# which a non-interactive CI shell never fires. Shims work unconditionally.
eval "$(mise activate bash --shims)"

# Installs exactly the versions pinned in mise.toml.
mise install
mise reshim

# Fail loudly here rather than with a confusing error inside a later step.
node --version
pnpm --version
