# Per-repo `worktree.json`

A repo can commit a `worktree.json` at its root (the `main/` checkout, not the
parent directory holding the worktrees) to configure what happens in each new
worktree. `.cursor/worktrees.json` is read too.

## Setup commands

```json
{
  "setup-worktree": ["pnpm install", "cp $ROOT_WORKTREE_PATH/.env .env"]
}
```

Commands run inside the new worktree with `ROOT_WORKTREE_PATH` pointing at the
main checkout. Because this is arbitrary repository-controlled shell code,
grove does not run it by default. Review the file first, then opt in with
`--setup`:

```bash
wt new my-service "fix login" --setup
```

A failing command warns and continues rather than aborting the worktree. The
older `--no-setup` flag remains accepted for compatibility.

## Worktree ports

Give every worktree its own block of local ports, so you can run several
checkouts' dev servers side by side. Declare a port block and named service
offsets:

```json
{
  "ports": {
    "perWorktree": 20,
    "worktreeSlots": 50,
    "services": {
      "webapp": {
        "offset": 0,
        "dotenv": { "env": "PORT" },
        "compose": { "target": 3000 }
      },
      "api": { "offset": 1, "dotenv": { "env": "API_PORT" } }
    }
  }
}
```

### Choosing a base port

Choose a machine-local start port when cloning or registering the repo with
`--base-port 3800`, or run `grove port configure --base-port 3800` inside an
existing clone. grove checks configured ranges against other registered repos.

The main checkout uses slot 0; new worktrees use the first free slot starting
at 1. With this example, the main checkout starts at 3800 and the first task
worktree starts at 3820. In that worktree, grove writes `PORT=3820` to `.env`
for a host-run webapp. Its Compose override publishes `3820:3000` without
changing the container environment. The API's generated host port is 3821.

### Reading ports

From inside a worktree:

```bash
grove port                                  # this worktree's block start
grove port --service api                    # one service's port
grove port exec webapp -- pnpm exec next dev  # run with PORT set in the environment
```

`port exec` is needed for tools such as Next.js that choose their listening
port before loading `.env`.

### Generated files

grove writes the declared env variables and the local Compose override after
worktree setup commands. `grove port --generate` regenerates both later;
`--generate-env` and `--generate-compose` regenerate one format. Ignore
generated local files in Git.

**`.env`** — `dotenv.path` defaults to `.env`. `dotenv.env` receives the
computed host port. Env generation updates only the configured variables.

**`compose.override.yaml`** — Docker Compose loads it automatically, and grove
refuses to overwrite an existing hand-written file. `compose.target` is the
container's listening port; grove does not change container environment
variables. Set `compose.service` when the Compose service name differs from
the grove service name. The generated file uses Compose's `!override` tag to
replace the service's complete `ports` list, including any fixed ports in the
base file, so declare every port you want to publish for that service. This
requires Docker Compose 2.24.4 or newer.

### Running out of slots

The default is 50 secondary worktree slots. grove warns when five or fewer
unique slots remain. After all slots are occupied, assignments wrap through
slots 1–50 and warn about the duplicate. Review eligible old worktrees with
`grove cleanup <repo> --merged --dry-run`; `git worktree prune` only clears
records for worktree directories that are already missing.

For the reasoning behind this design, see the
[port design](../development/port-offset-plan.md) and
[integration conventions](../development/port-conventions.md).
