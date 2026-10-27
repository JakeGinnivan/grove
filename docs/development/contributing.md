# Development and releasing

## Development

Node 24+ and pnpm 11+. With [mise](https://mise.jdx.dev), `mise install` picks
both up from `mise.toml`; otherwise see [pnpm's install
guide](https://pnpm.io/installation) — pnpm ships a native binary, so Corepack
is not involved (Node removed it in v25).

```bash
pnpm install
pnpm build       # bundle to dist/
pnpm test        # unit + integration tests against real git repos
pnpm typecheck
```

Built with TypeScript 7. Integration tests run the built bundle against
throwaway git repos with a redirected `HOME`, so they exercise what ships
without touching your real configuration.

CI runs the suite on Node 24 across Linux, macOS, and Windows.

The agent skills live in `src/skills/templates/`. `grove skills install`
copies them out, so edit them there.

## Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets),
which need no GitHub token and work offline. When you change something users
can observe, describe it:

```bash
pnpm changeset
```

Pick the bump and write a sentence for the release notes. Commit the generated
file with your change.

CI fails a branch that touches the package without one. That is wider than just
`src/`: changesets counts any tracked file outside a dot-directory, so `docs/`,
`test/` and the README need one too. Changes confined to `.buildkite/`,
`.github/` or `.vscode/` do not.

For a change that ships nothing users can observe — a refactor, a test, a docs
fix — add a changeset with no bump:

```bash
pnpm changeset add --empty
```

That satisfies the check and adds nothing to the changelog.

On merge to `main`, CI opens a **Publish Release** PR that applies the pending
changesets — bumping the version and folding them into `CHANGELOG.md`. The
version PR is the release gate: nothing ships until you merge it.

Merging it **stages** the release on npm rather than publishing it. Staging
needs no 2FA and so can happen in CI; approving requires 2FA and so happens
from your machine:

```bash
npm stage list @jakeginnivan/grove
npm stage view <stage-id>       # inspect before approving
npm stage approve <stage-id>    # publishes it
```

The build annotates the staged version with these commands when it finishes.
See [`npm help stage`](https://docs.npmjs.com/cli/commands/npm-stage) for the
full flow.

Releases are published with a token rather than [npm trusted
publishing](https://docs.npmjs.com/trusted-publishers/) over OIDC: npm does not
support Buildkite as a trusted publisher. Packages published this way carry no
provenance attestation, so `npm audit signatures` has nothing to verify.
