---
name: wt-repos
description: Discover which git repositories are cloned locally and where they live on disk, learn which profile (work, oss, personal) a repository belongs to and what rules apply to it, and bring a repository's main checkout up to date before reading its code. Use when you need to inspect, search, or answer questions about a repository that is not in the current working directory, when the user refers to a repo by a short name or alias, or before copying or referencing code between repositories.
---

# Local repository discovery

Repositories cloned with `grove` are registered in a local registry. Use the
CLI to find them rather than guessing paths or searching the filesystem.

The `wt` command in the user's shell is a wrapper around `grove`. In scripts
and tool calls, invoke `grove` directly — the wrapper only adds `cd` support.

## List available repositories

```bash
grove repos --json
```

Returns:

```json
{
  "ok": true,
  "registryFile": "/Users/you/.wt_repos",
  "repos": [
    {
      "name": "my-service",
      "aliasOf": null,
      "path": "/Users/you/_code/work/my-service",
      "mainPath": "/Users/you/_code/work/my-service/main",
      "exists": true
    },
    { "name": "ms", "aliasOf": "my-service", "path": "...", "mainPath": "...", "exists": true }
  ]
}
```

Key points:

- `mainPath` is the checkout to read code from. **Always use `mainPath`, not
  `path`** — `path` is the parent directory that also contains task worktrees.
- Entries with `aliasOf` set are short aliases. Either name works as `<repo>`.
- `exists: false` means the directory is missing; report this rather than
  trying to read it.

## Profiles and their rules — read before crossing repositories

Repositories are grouped into profiles by directory. A profile carries a
policy: which hosts it may push to, and rules about how its code may be used.

```bash
grove profile list --json
```

```json
{
  "ok": true,
  "defaultProfile": "work",
  "profiles": [
    {
      "name": "work",
      "dir": "/Users/you/_code/work",
      "description": "Internal work code",
      "blockPushTo": ["github.com"],
      "rules": ["Never copy code from other profiles into this one (licensing)."],
      "isDefault": true
    },
    {
      "name": "oss",
      "dir": "/Users/you/_code/oss",
      "description": "Open-source dependencies, for reference",
      "blockPushTo": [],
      "rules": ["Reference only. Do not copy source into work repositories."]
    }
  ]
}
```

**A repository's profile is determined by which profile directory contains
its path.** Match the repo's `path` against each profile's `dir`.

These rules are binding constraints, not suggestions:

- **Never copy source code from one profile into another** unless a rule
  explicitly permits it. Copying open-source code into a work repository can
  create a licensing violation that is expensive to unwind.
- Reading code across profiles to *understand* an API or behaviour is fine.
  Reproducing it verbatim in another profile is not.
- When you need behaviour from a dependency in another profile, describe the
  approach and write a fresh implementation, or use the dependency through its
  published package.
- If a task appears to require crossing a rule, stop and ask the user.

`blockPushTo` means git itself is configured to refuse pushes to those hosts
from that directory. If a push fails with `grove-push-blocked://`, that is the
policy working as intended — do not attempt to bypass it.

## Update a repo before reading it

The main checkout can be stale. Fast-forward it before inspecting code:

```bash
grove sync <repo> --json
```

Sync every registered repo by omitting the name:

```bash
grove sync --json
```

`grove sync` is deliberately conservative. It fetches, then fast-forwards only
when the main checkout is clean and on the default branch. Otherwise it
reports a `skipped` reason and changes nothing:

```json
{
  "ok": true,
  "results": [
    { "repo": "my-service", "path": "/Users/you/_code/work/my-service/main",
      "branch": "main", "updated": true, "skipped": null,
      "from": "a1b2c3d…", "to": "e4f5g6h…" }
  ]
}
```

If `skipped` is non-null, tell the user why instead of forcing it. A skip
means someone has work in progress in that checkout.

## Inspecting other worktrees

To see in-progress branches for a repo:

```bash
grove list <repo> --json
```

Each entry includes `path`, `branch`, `dirty`, `ahead`, `merged`, and `parent`
(the branch it was stacked on, when applicable).

## Rules

- Never `cd` into a worktree to read files; use absolute paths from the JSON.
- Never run `git pull`, `git checkout`, or `git reset` in a repo you did not
  create. Use `grove sync`, which refuses to clobber uncommitted work.
- Do not modify files in a `mainPath` checkout. It is for reading. To make
  changes, create a worktree — see the `wt-worktree` skill.
- Check the profile rules before moving any code between repositories.
