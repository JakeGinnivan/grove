import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('creates a GitHub release after staging through the changesets hook', () => {
  const fixtures = fileURLToPath(
    new URL('../.buildkite/plugins/changesets/tests/release.sh', import.meta.url),
  )
  expect(execFileSync('bash', [fixtures], { encoding: 'utf8' })).toContain(
    'Release hook fixtures passed.',
  )
})
