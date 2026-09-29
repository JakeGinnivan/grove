#!/usr/bin/env bash
# Fails the job when the changesets CLI cannot even load.
#
# Must be *sourced*, not executed.
#
#   source "$PLUGIN_DIR/lib/require-cli.sh"
#   require_changeset_cli
#
# The modes deliberately tolerate a failing `changeset status`, because 3.x
# exits 1 for "nothing to release". That tolerance cannot tell a real answer
# from a CLI that crashed on load, and a crash read as "nothing pending" once
# sent a build with eight pending changesets down the release path, green.
# `--version` loads the same bundle, so checking it first separates the two.

require_changeset_cli() {
  local out
  if ! out="$(npx --no-install changeset --version 2>&1)"; then
    echo "$out" >&2
    echo >&2
    echo "The changesets CLI failed to load under node $(node --version 2>/dev/null || echo '(none on PATH)')." >&2
    echo "This hook runs after the step's command, but PATH changes that command makes" >&2
    echo "do not reach it. Put the toolchain on PATH from a hook instead, such as a" >&2
    echo "repository post-checkout hook." >&2
    exit 1
  fi
}
