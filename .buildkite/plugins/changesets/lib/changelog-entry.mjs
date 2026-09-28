// Extracts one version's section from CHANGELOG.md, for the GitHub release body.
//
// Mirrors what changesets/action did before this repo moved to Buildkite: the
// release body is the changelog section for the version being released, so the
// release and the changelog cannot drift apart.
//
// Usage: changelog-entry.mjs <version> [changelog-path]
// Writes the section to stdout. Exits 1 if there is no section for the version.

import { readFile } from 'node:fs/promises'

const [version, changelogPath = 'CHANGELOG.md'] = process.argv.slice(2)

if (!version) {
  console.error('usage: changelog-entry.mjs <version> [changelog-path]')
  process.exit(1)
}

let changelog
try {
  changelog = await readFile(changelogPath, 'utf8')
} catch {
  console.error(`No ${changelogPath}.`)
  process.exit(1)
}

// Headings are matched by their *text* rather than a fixed `## x.y.z` pattern,
// the way changesets/action does it: the heading depth is whatever the
// changelog generator chose, and only the text is reliably the bare version.
//
// The fenced-code alternative in the pattern matters — a changelog entry may
// contain a fenced block whose content starts with `#`, and without tracking
// fences those lines would be read as headings. grove's own 0.3.1 entry has
// one.
const TOKEN = /^(#{1,6})\s+(.*)$|^(`{3,})/gm

let start = null
let startDepth = 0
let end = changelog.length
let fence = null

for (const match of changelog.matchAll(TOKEN)) {
  const [text, hashes, headingText, backticks] = match

  if (backticks) {
    // Fences nest by length: a longer run closes nothing, it opens a block
    // that a matching-or-longer run closes.
    if (fence === null) {
      fence = backticks.length
    } else if (backticks.length >= fence) {
      fence = null
    }
    continue
  }

  if (fence !== null) {
    continue
  }

  const depth = hashes.length

  if (start === null) {
    if (headingText.trim() === version) {
      start = match.index + text.length
      startDepth = depth
    }
    continue
  }

  // The section ends at the next heading of the same depth or shallower. A
  // deeper one (`### Patch Changes`) is part of this version's section.
  if (depth <= startDepth) {
    end = match.index
    break
  }
}

if (start === null) {
  console.error(`No changelog section for ${version} in ${changelogPath}.`)
  process.exit(1)
}

const entry = changelog.slice(start, end).trim()

if (!entry) {
  console.error(`Changelog section for ${version} is empty.`)
  process.exit(1)
}

console.log(entry)
