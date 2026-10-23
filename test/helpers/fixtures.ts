import { test } from 'vitest'
import { createSandbox, type Sandbox } from './sandbox.js'

/**
 * `it` with a fresh sandbox for each test that names `sandbox` in its
 * context, removed again once the test ends. A fixture rather than a
 * `beforeEach` into a shared variable, so a test that never asks for one
 * skips the git setup, and tests in a file can run concurrently.
 */
export const it = test.extend<{ sandbox: Sandbox }>({
  sandbox: async ({}, use) => {
    const sandbox = await createSandbox()
    await use(sandbox)
    await sandbox.cleanup()
  },
})
