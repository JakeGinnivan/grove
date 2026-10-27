# Worktree port offsets

Status: core allocation, lookup, env generation, and launch support implemented;
repacking is deferred.

## Goal

Give each checkout of a repository a stable block of local development ports. Reuse
the lowest free worktree slot after cleanup, and let different repositories occupy
different port ranges on the same machine. Port assignments are advisory: Grove
does not bind sockets or stop other processes from using them.

## Configuration

Add a `ports` section to the existing, committed `worktree.json` in the main
checkout. The same file already defines optional `setup-worktree` commands.

```json
{
  "setup-worktree": ["pnpm install", "cp $ROOT_WORKTREE_PATH/.env .env"],
  "ports": {
    "perWorktree": 20,
    "worktreeSlots": 50,
    "services": {
      "webapp": {
        "offset": 0,
        "dotenv": { "env": "PORT" },
        "compose": { "target": 3000 }
      },
      "api": { "offset": 1, "dotenv": { "env": "API_PORT" } },
      "worker": { "offset": 2, "dotenv": { "env": "PORT", "path": "apps/worker/.env" } }
    }
  }
}
```

`perWorktree` is the block width; each service offset must be a distinct integer
from `0` through `perWorktree - 1`. `worktreeSlots` defaults to 50 *secondary*
worktrees; the main checkout is always slot 0. Service names are for Grove's
CLI, while `dotenv.env` names the host port variable and `dotenv.path` selects
its file (default `.env`). Different files may use the same env variable name.
Env file paths are relative to the worktree and must stay inside it.
`compose.target` is the fixed container port; Grove publishes the computed
worktree port on the host without changing the container environment.
`compose.service` overrides the default same-name service mapping. For base
port 3800 and slot 1, the webapp's offset 0 produces `3820:3000` and
`PORT=3820` in `.env`.

The machine-specific `basePort` belongs in the clone's local Git config, not
in the committed file. `grove clone <url> --base-port 3800` and
`grove repos add <path> --base-port 3800` configure it; interactive registration can
prompt when `worktree.json` declares ports. Existing registered clones need a
`grove port configure --base-port 3800` route. Noninteractive clone/import
without a base port should still register the repo, but clearly report that
port allocation is not configured yet.

Validate that the whole range fits within TCP/UDP port numbers and does not
overlap another registered repo's configured range. Since Grove only records
intent, it cannot guarantee that unrelated local processes leave the range
free.

## Assignment and lookup

For base port `3800` and block width `20`, slot 0 gets `3800–3819`, slot 1
gets `3820–3839`, and service offset 1 in slot 1 is `3821`. The last unique
worktree slot is 50; its block ends at `4819`.

Both `grove new` and `grove checkout` use the existing shared creation path.
After Git creates the worktree, Grove assigns the lowest unused slot in
`1..worktreeSlots` and records it in that worktree's Git administrative data.
This data is local and goes away with the worktree's Git registration. The main
checkout needs no stored assignment. Existing worktrees are assigned the first
time they run a port command; their chosen slot then remains stable.

When every slot is used, assignment wraps: first overflow uses slot 1, next
uses slot 2, and so on. The overflow cursor persists in local repository state
so separate Grove invocations continue the sequence. A duplicate assignment
always emits a warning, including a machine-readable warning in JSON output.
Warn when five or fewer unique slots remain, with a suggestion to inspect
`grove cleanup <repo> --merged --dry-run` and then remove eligible worktrees.
Never silently change an existing worktree's slot to repair a duplicate.

Port calculation is `basePort + slot * perWorktree + service.offset`.
`grove port` prints the current checkout's block start as a single number;
`grove port --service webapp` prints that service's port. JSON output includes
the repo, worktree, slot, port and any capacity/duplicate warning. The lookup
should work from any directory inside the checkout.

Allocation is not locked in this version. Two Grove processes creating
worktrees at precisely the same time can choose the same free slot; if this
proves relevant, add a short atomic claim around read/assign/write.

## Environment and startup

`grove port --generate-env` updates only configured env keys in each specified
file, keeping unrelated values and comments. It replaces old assignments for
those keys rather than appending duplicates. `grove port --generate-compose`
writes configured Compose overrides, and `grove port --generate` regenerates
both. A new worktree runs all configured projections automatically **after**
optional setup commands, so a repository's bootstrap can create `.env` first.
Port generation itself does not require opting into executable setup commands.

Grove writes a dedicated, marked `compose.override.yaml` and refuses to
replace a hand-written file. Docker Compose loads this filename automatically.
The generated `ports: !override` replaces the whole published ports list for
each mapped Compose service, so map every port that service must publish.
`!override` requires Docker Compose 2.24.4 or later. Ignore generated local
files in Git. See [Compose merge rules](https://docs.docker.com/reference/compose-file/merge/).

An env file is not universally enough to select a server's listening port.
For example, Next.js reads `PORT` before loading `.env`, and Vite can move to
another port if the configured one is occupied. Provide a launch-time command
such as `grove port exec webapp -- pnpm exec next dev` that sets the service's
configured env variable before starting the process. Document framework
specific configuration where necessary. See [port conventions](port-conventions.md).

## Cleanup and later repacking

`grove cleanup` releases an assignment when it successfully removes a
worktree, including when the directory is moved to trash and its stale Git
registration is pruned. A skipped or failed cleanup retains the assignment.
If a worktree directory was manually deleted, Git's `worktree prune` removes
only its stale registration; it does **not** decide whether the branch's work
has been merged or whether an existing checkout is safe to remove. Grove's
`cleanup --merged` performs that separate eligibility check.

Defer `grove port repack`. A future command should preview slot moves and
resulting port/env changes, then require an explicit apply. It must keep main
at slot 0, avoid moving assignments unnecessarily, regenerate affected env
files, and warn that running servers may still be bound to their old ports.
Repacking is never automatic because it changes ports for existing worktrees.
