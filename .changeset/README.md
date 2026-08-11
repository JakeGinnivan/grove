# Changesets

This folder holds unreleased change descriptions. Each `.md` file here records
one user-visible change and the version bump it deserves.

Add one whenever you change behaviour:

```bash
pnpm changeset
```

Pick the bump (patch/minor/major) and write a sentence aimed at someone reading
the release notes, not at a reviewer reading the diff. Commit the generated file
alongside your change.

Changes that users cannot observe — refactors, test-only edits, CI tweaks —
need no changeset.

On merge to `main`, CI opens a "Version Packages" PR that applies every pending
changeset: it bumps the version, folds these files into `CHANGELOG.md`, and
deletes them. Merging that PR publishes to npm.

Full docs: https://github.com/changesets/changesets
