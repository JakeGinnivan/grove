import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Integration tests drive dist/cli.mjs, so the bundle must match src.
    // Building here (rather than only in a pretest script) keeps a bare
    // `vitest` run from silently testing stale output.
    globalSetup: ['./test/helpers/build.ts'],
    // The slowest test takes about 3s; a run that needs much more than that
    // is stuck, and waiting out a long limit on every test turns one hang
    // into a twenty-minute suite.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
