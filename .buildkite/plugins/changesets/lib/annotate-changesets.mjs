// Renders `changeset status --output` JSON as markdown for a Buildkite
// annotation, so the planned version bump is visible on the build itself
// rather than only in the step log.
//
// Reads the JSON on stdin, writes markdown on stdout.

const input = await new Promise((resolve, reject) => {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => (buf += c))
  process.stdin.on('end', () => resolve(buf))
  process.stdin.on('error', reject)
})

// A parse failure must not pipe a Node stack trace into the build annotation.
// The status report is informational, so degrade to a plain note instead.
let releases = []
let changesets = []
try {
  ;({ releases = [], changesets = [] } = JSON.parse(input))
} catch {
  console.log('Could not read the changeset status report.')
  process.exit(0)
}

if (releases.length === 0) {
  console.log('No packages will be released by this change.')
  process.exit(0)
}

const rows = releases
  .map((r) => `| \`${r.name}\` | ${r.type} | ${r.oldVersion} | **${r.newVersion}** |`)
  .join('\n')

// `summary` is the changeset's own body text, which is what lands in the
// changelog — worth showing so a wrong bump type is caught at review time.
const summaries = changesets
  .map((c) => `- ${c.summary.trim().split('\n')[0]}`)
  .join('\n')

console.log(`**This PR will release:**

| package | bump | from | to |
| --- | --- | --- | --- |
${rows}

${summaries}`)
