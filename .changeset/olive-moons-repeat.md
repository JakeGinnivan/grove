---
'@jakeginnivan/grove': patch
---

Fix the `grove` command being missing after install. The `bin` path carried a
`./` prefix, which npm rejects — it dropped the entry at publish time, so the
package installed without providing the command.
