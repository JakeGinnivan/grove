---
"@jakeginnivan/grove": patch
---

Report the real version, and accept `-v` for it

The version was a hardcoded constant in `src/cli.ts` that nothing kept in step
with `package.json`, so every release after 0.1.0 would have kept reporting
`0.1.0` no matter which version was installed. It is now read from
`package.json` at startup, leaving changesets' bump as the only place a version
is written.

The flag is `-v` rather than commander's default `-V`; nothing here uses `-v`
for verbosity.
