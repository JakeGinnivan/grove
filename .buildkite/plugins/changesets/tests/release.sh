#!/usr/bin/env bash
# Exercise the real post-command -> publish -> create-release process boundary.
# All external effects are replaced with local commands; no registry or API calls.
set -euo pipefail
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/bin" "$FIXTURE/home"
export HOME="$FIXTURE/home"
export PATH="$FIXTURE/bin:$PATH"
export API_LOG="$FIXTURE/api.log"
export ANNOTATION="$FIXTURE/annotation"
export GITHUB_TOKEN='fixture-token' NPM_TOKEN='fixture-token'
export BUILDKITE_REPO='https://github.com/example/package.git'
export BUILDKITE_BRANCH=main
export BUILDKITE_PLUGIN_CHANGESETS_MODE=release
export BUILDKITE_PLUGIN_CHANGESETS_PUBLISH=stage
export BUILDKITE_PLUGIN_CHANGESETS_NPM_USER=example
export BUILDKITE_COMMAND_EXIT_STATUS=0
# A child shell must initialize its own API helper, as on the hosted agents.
unset -f github_api 2>/dev/null || true
cat > "$FIXTURE/bin/git" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$FIXTURE/bin/npm" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == view ]]; then exit 1; fi
if [[ "$*" == 'stage publish --json' ]]; then
  echo '{"stageId":"fixture-stage"}'
else
  echo "Unexpected npm call: $*" >&2
  exit 1
fi
SH
cat > "$FIXTURE/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$API_LOG"
if [[ "$*" == *'/releases/tags/'* ]]; then
  exit "${EXISTING_RELEASE_STATUS:-22}"
fi
exit "${CREATE_RELEASE_STATUS:-0}"
SH
cat > "$FIXTURE/bin/buildkite-agent" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == annotate ]]; then cat > "$ANNOTATION"; else exit 1; fi
SH
chmod +x "$FIXTURE/bin/"*
cd "$FIXTURE"
printf '{"name":"fixture-package","version":"1.2.3"}\n' > package.json
printf '# Changelog\n\n## 1.2.3\n\n### Patch Changes\n\n- Fixed the fixture.\n' > CHANGELOG.md

"$PLUGIN_DIR/hooks/post-command" > output.log 2>&1 || {
  cat output.log
  exit 1
}
node - "$API_LOG" "$ANNOTATION" <<'JS'
const fs = require('node:fs')
const assert = require('node:assert/strict')
const args = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n')
assert(args.includes('https://api.github.com/repos/example/package/releases/tags/v1.2.3'))
assert(args.includes('Authorization: Bearer fixture-token'))
assert(args.includes('POST'))
const release = JSON.parse(args[args.indexOf('-d') + 1])
assert.equal(release.tag_name, 'v1.2.3')
assert.match(release.body, /Fixed the fixture/)
assert.match(release.body, /npm stage approve fixture-stage/)
assert.equal(release.prerelease, false)
assert.match(fs.readFileSync(process.argv[3], 'utf8'), /npm stage approve fixture-stage/)
JS

# Rerunning after the GitHub release exists must skip creation.
: > "$API_LOG"
EXISTING_RELEASE_STATUS=0 "$PLUGIN_DIR/hooks/post-command" > output.log 2>&1
if grep -q '^POST$' "$API_LOG"; then
  echo 'An existing release was created again.' >&2
  exit 1
fi

# A genuine API error still fails the job.
if CREATE_RELEASE_STATUS=22 "$PLUGIN_DIR/hooks/post-command" > output.log 2>&1; then
  echo 'Release creation failure was ignored.' >&2
  exit 1
fi
echo 'Release hook fixtures passed.'
