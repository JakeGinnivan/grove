import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * Build the bundle before the suite runs. Integration tests exercise
 * dist/cli.mjs, so testing a stale build would quietly pass or fail for the
 * wrong reasons.
 */
export function setup(): void {
  execFileSync('npx', ['tsdown'], {
    cwd: projectRoot,
    stdio: 'ignore',
  })
}
