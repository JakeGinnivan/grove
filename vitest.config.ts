import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Integration tests drive dist/cli.mjs, so the bundle must match src.
    // Building here (rather than only in a pretest script) keeps a bare
    // `vitest` run from silently testing stale output.
    globalSetup: ['./test/helpers/build.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
