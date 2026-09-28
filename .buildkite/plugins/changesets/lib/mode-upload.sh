#!/usr/bin/env bash
# Decides which half of the release this build is, and uploads the steps for it.
#
# The decision is made *here*, at upload time, so the step is named for what it
# does before it runs. Deciding at runtime instead means one ambiguous step
# whose meaning you learn from the log.
set -euo pipefail

: "${PLUGIN_DIR:?must be run through the plugin command hook}"

PUBLISH_MODE="${BUILDKITE_PLUGIN_CHANGESETS_PUBLISH:-publish}"

# BUILDKITE_PULL_REQUEST is the literal string "false" on a non-PR build, not
# an empty value -- comparing against "false" is deliberate.
#
# Release only from the tip of the default branch, and never from a PR build
# targeting it. Both conditions matter: a PR build also reports a branch.
if [[ "$BUILDKITE_BRANCH" != "$BUILDKITE_PIPELINE_DEFAULT_BRANCH" || "$BUILDKITE_PULL_REQUEST" != "false" ]]; then
  echo "Not the tip of the default branch; nothing to release."
  exit 0
fi

# On @changesets/cli 2.31.1 this exits 0 and writes the file even when there is
# nothing to release. That is NOT true on 3.x, where the empty case exits 1 and
# writes no file at all -- which under `set -e` would fail the upload on a
# perfectly green build. Tolerate both: a missing file means "nothing pending",
# and the exit code is deliberately not trusted either way.
STATUS_JSON="$PWD/changeset-status.json"
rm -f "$STATUS_JSON"
npx --no-install changeset status --output "$STATUS_JSON" || true

if [[ -s "$STATUS_JSON" ]]; then
  PENDING="$(node -e 'const s=require(process.argv[1]);console.log(s.releases.length)' "$STATUS_JSON")"
else
  PENDING=0
fi

# Plugin config objects arrive as BUILDKITE_PLUGIN_..._<KEY> vars; gather the
# agent tags back into an object.
collect_agents() {
  local prefix='BUILDKITE_PLUGIN_CHANGESETS_AGENTS_'
  node -e '
    const prefix = process.argv[1]
    const out = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith(prefix)) {
        out[k.slice(prefix.length).toLowerCase()] = v
      }
    }
    console.log(JSON.stringify(out))
  ' "$prefix"
}

# The generated step re-references *this plugin* rather than calling a script by
# path. $PLUGIN_DIR is a checkout directory on the agent running the upload, and
# the step it generates may well be picked up by a different agent, where that
# path does not exist.
#
# The version the step pins is the version this upload is running as, read from
# BUILDKITE_PLUGINS, so a pipeline pinned to a tag cannot silently get a
# different version in its second half.
emit_step() {
  local label="$1" step_mode="$2"
  node -e '
    const [label, stepMode, agentsJson, group, command, pluginsJson, publishMode,
           release, npmUser] = process.argv.slice(1)

    // Find how this pipeline referred to the plugin, and reuse it verbatim, so
    // the generated step resolves the same way this one did -- including a
    // pinned tag or SHA, a full git URL, or a vendored relative path.
    //
    // Matching on the *config* rather than the name: a plugin may be referenced
    // as `org/changesets#v1`, as a full URL, or vendored as
    // `./.buildkite/plugins/whatever`, and only the last of those is guaranteed
    // to carry our name. The entry running right now is the one whose config
    // has the `mode` we were invoked with.
    let ref = null
    try {
      for (const entry of JSON.parse(pluginsJson || "[]")) {
        if (typeof entry !== "object" || entry === null) { continue }
        const [key, config] = Object.entries(entry)[0] ?? []
        if (config && typeof config === "object" && config.mode === "upload") {
          ref = key
          break
        }
      }
    } catch {}

    if (!ref) {
      console.error(
        "Could not find this plugin in BUILDKITE_PLUGINS, so the generated step\n" +
        "would not know which version to run. Expected an entry whose config\n" +
        "sets mode=upload.\n" +
        "BUILDKITE_PLUGINS was: " + (pluginsJson || "(unset)"))
      process.exit(1)
    }

    const config = { mode: stepMode, publish: publishMode }
    if (release === "false") { config.release = false }
    if (npmUser) { config["npm-user"] = npmUser }

    const step = {
      label,
      plugins: [{ [ref]: config }],
      concurrency: 1,
      concurrency_group: group,
    }
    if (command) { step.command = command }

    const agents = JSON.parse(agentsJson || "{}")
    if (Object.keys(agents).length) { step.agents = agents }

    console.log(JSON.stringify({ steps: [step] }))
  ' "$label" "$step_mode" "$(collect_agents)" \
    "${BUILDKITE_PIPELINE_SLUG}/changesets-release" \
    "${BUILDKITE_PLUGIN_CHANGESETS_COMMAND:-}" \
    "${BUILDKITE_PLUGINS:-[]}" \
    "$PUBLISH_MODE" \
    "${BUILDKITE_PLUGIN_CHANGESETS_RELEASE:-true}" \
    "${BUILDKITE_PLUGIN_CHANGESETS_NPM_USER:-}"
}

if [[ "$PENDING" -gt 0 ]]; then
  echo "Pending changesets: this build opens the version PR."
  emit_step ':memo: version packages' version | buildkite-agent pipeline upload
  exit 0
fi

if [[ "$PUBLISH_MODE" == "none" ]]; then
  echo "No pending changesets, and publish=none: nothing to upload."
  exit 0
fi

echo "No pending changesets: this build releases."
LABEL=':rocket: publish'
if [[ "$PUBLISH_MODE" == "stage" ]]; then
  LABEL=':rocket: stage to npm'
fi
emit_step "$LABEL" release | buildkite-agent pipeline upload
