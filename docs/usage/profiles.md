# Profiles

A profile is a base directory that repositories are grouped under. Typical
setup: work code in one directory, alongside open-source dependencies you read
but do not modify.

```bash
grove profile add work ~/_code/work \
  --description "Internal work code" \
  --rule "Never copy code from other profiles into this one (licensing)."

grove profile add oss ~/_code/oss \
  --description "Open-source dependencies, for reference" \
  --rule "Reference only. Do not copy source into work repositories."

grove profile default work
```

A profile decides where `grove clone` puts a repo, and carries `--rule`
statements that the agent skills surface.

## What adding a profile writes

Adding one configures it immediately — there is no second step. Each write goes
inside a marked block grove owns, so your own settings survive:

| File | What it gets |
| --- | --- |
| `<profile>/.gitconfig` | A managed header; add your own per-profile git settings below it |
| `~/.gitconfig` | `includeIf gitdir:` stanzas pointing at each profile config |
| `~/.claude/settings.json` | `additionalDirectories` + `Read(<dir>/**)` so agents can read your repos |

The per-profile `.gitconfig` is wired up but intentionally empty. Anything you
add below the managed block applies to every repo in that directory — a work
email, a signing key, or `pushInsteadOf` rules if you want to block a host:

```ini
# ~/_code/work/.gitconfig, below the grove-managed block
[url "blocked://"]
	pushInsteadOf = https://github.com/
```

Cloning a URL into a profile that blocks its host is refused outright.

Because these files live outside the project, an interactive run lists them
and asks once before writing. Pass `-y` to skip the prompt, or `--no-apply`
to record the profile without touching anything.

Removing a profile (`grove profile remove <name>`) cleans up after itself: its
`includeIf` stanza and grove's managed block both go, and hand-written config
is left alone.

## Re-syncing

`grove profile apply` re-syncs everything. You need it only after editing
`~/.config/grove/config.json` by hand, or when setting up a new machine from
an existing config. It is idempotent; `--dry-run` previews the changes.

## Choosing a profile when cloning

`wt clone` picks one: `--profile` wins, then the default profile, then a prompt
when several exist and none is the default. Non-interactively without a
default, pass `--profile <name>`.

```bash
wt clone git@github.com:facebook/react.git --profile oss
```

Set or inspect the default at any time:

```bash
grove profile default        # show the current default
grove profile default work   # set it
grove profile default --clear
```

## Rules for agents

Rules are surfaced to agents through `grove profile list --json` and the
installed [skills](agents.md), so an assistant working in your `work` tree
knows it may read `oss` code but not copy it across.
