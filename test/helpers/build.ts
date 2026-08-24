import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * tsdown's own entry point, run with the Node binary already executing the
 * tests. Spawning `npx` instead would fail on Windows, where the executable
 * is `npx.cmd` and execFileSync does not resolve the extension.
 */
const tsdownEntry = resolve(projectRoot, 'node_modules/tsdown/dist/run.mjs')

/**
 * Build the bundle before the suite runs. Integration tests exercise
 * dist/cli.mjs, so testing a stale build would quietly pass or fail for the
 * wrong reasons.
 */
export function setup(): void {
  execFileSync(process.execPath, [tsdownEntry], {
    cwd: projectRoot,
    stdio: 'ignore',
  })
}
