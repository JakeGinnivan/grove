# Repositories

grove keeps each repo's primary checkout in `<repo>/main`, so sibling
directories can be worktrees. Every repo grove manages is registered by name,
which is what you pass to `wt new`, `wt pick` and the rest.

Examples use `wt`; `grove` works identically.

## Clone a repo

```bash
wt clone git@github.com:owner/my-service.git
```

Clones into `<code-dir>/my-service/main` and registers it. When you have
[profiles](profiles.md), the clone goes under one: `--profile` wins, then the
default profile, then a prompt when several exist and none is the default.

## Adopt an existing local repo

```bash
wt import ~/src/my-service
```

When the repo is a plain clone, `import` says so and offers to move it into a
`main/` subfolder, in place. The repo's own path does not change, so anything
pointing at the folder still resolves:

```
~/src/my-service/        →   ~/src/my-service/main/
```

Pass `--restructure` or `--no-restructure` to decide without being asked
(required under `--json`, since the move touches files). A repo with linked
worktrees is refused rather than broken, and `-p <profile>` / `--dir <path>`
additionally move the repo under a profile directory.

To register a repo without touching its layout at all, pass
`--no-restructure`.

> `wt repos add` is deprecated: it now forwards to `wt import
> --no-restructure` and prints a warning. It will be removed in v1.

## Start a new repo

```bash
wt create my-tool
```

Creates `<code-dir>/my-tool/main`, runs `git init` on branch `main`, and
registers it.

When the [GitHub CLI](https://cli.github.com) is installed and logged in, it
then offers to create the repo on GitHub too (defaulting to no, then asking
for visibility) and wires it up as `origin`:

```
◆  Create "my-tool" on GitHub too?
│  ○ Yes / ● No
```

`--github` skips straight to creating it (private unless `--visibility` says
otherwise), `--no-github` skips the question, and `--owner` creates it under
an org. Nothing is pushed — a fresh repo has no commits yet. If the GitHub
step fails, the local repo is still created and registered.

Set `GROVE_NO_GITHUB=1` to stop grove shelling out to `gh` at all.

The repo has no commits yet, so make the first one before asking for a
worktree. Without a remote there is also no base to infer, so name it:

```bash
wt new my-tool "my task" --base main
```

## List and unregister

```bash
wt repos                 # registered repos and their paths
wt repos remove my-tool  # unregister; files are left alone
```

## The registry and aliases

Repos are recorded in `~/.wt_repos` (configurable, see
[Configuration](configuration.md)). The format is shared with the original zsh
helper, so an existing file keeps working:

```
my-service /Users/you/_code/my-service
ms my-service
```

The second line makes `ms` an alias for `my-service`.
