// Decides whether one package.json changed in a way only `changeset version`
// would produce.
//
// Usage: changed-manifest-keys.mjs <old-json-file> <new-json-file>
// Exits 0 if the change is a version bump and/or internal dependency-range
// rewrites; exits 1 otherwise.
//
// This compares parsed objects rather than diff text. The textual approach it
// replaces tried to read the enclosing JSON key out of git's hunk headers, but
// git emits no function context for JSON without a configured diff driver, so
// a dependency rewrite was indistinguishable from a top-level edit.

import { readFile } from 'node:fs/promises'

const DEP_BLOCKS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
])

const [oldPath, newPath] = process.argv.slice(2)

const read = async (p) => {
  if (!p) {
    return {}
  }
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    // An unparseable manifest is not something to wave through.
    process.exit(1)
  }
}

const before = await read(oldPath)
const after = await read(newPath)

const keys = new Set([...Object.keys(before), ...Object.keys(after)])

for (const key of keys) {
  const a = before[key]
  const b = after[key]

  if (JSON.stringify(a) === JSON.stringify(b)) {
    continue
  }

  // The version bump itself.
  if (key === 'version') {
    continue
  }

  // Within a dependency block, only the ranges may move: adding or removing a
  // dependency is a change `changeset version` would not make on its own.
  //
  // Which packages are internal is not knowable from one manifest, so any
  // range change is allowed. That is a deliberate limit -- it means a
  // range edit can ride along with a real bump -- and it is the reason this
  // gate is about shape, not trust.
  if (DEP_BLOCKS.has(key)) {
    const aDeps = a ?? {}
    const bDeps = b ?? {}
    const names = new Set([...Object.keys(aDeps), ...Object.keys(bDeps)])
    let ok = true
    for (const name of names) {
      if (!(name in aDeps) || !(name in bDeps)) {
        ok = false
        break
      }
    }
    if (ok) {
      continue
    }
  }

  process.exit(1)
}

process.exit(0)
