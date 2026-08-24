import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)

/**
 * Integration tests drive the built bundle, so they exercise exactly what
 * ships. Run `pnpm build` before `pnpm test` (the pretest script does this).
 */
const CLI = resolve(
  fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url)),
)

/**
 * Path git should treat as "no config here". Windows has no /dev/null; the
 * equivalent null device is NUL, and pointing git at a path that does not
 * exist on the platform makes config reads behave inconsistently.
 */
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

export interface Sandbox {
  root: string
  /** Bare repo standing in for origin. */
  remote: string
  /** Parent dir holding main/ and worktrees. */
  repoPath: string
  mainPath: string
  reposFile: string
  cleanup: () => Promise<void>
}

/**
 * Environment for every git invocation the fixtures make, so none of them
 * inherit the machine's real git configuration. `globalConfig` selects which
 * file acts as the global config: the null device for setup steps that must
 * be pristine, or the sandbox's own ~/.gitconfig when a test needs to observe
 * generated config.
 */
function gitEnv(globalConfig = NULL_DEVICE): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    // Git for Windows defaults core.autocrlf to true, which checks files out
    // with CRLF while the index holds LF — every file then reads as modified
    // and the checkout is permanently "dirty". Pin it off so the fixtures
    // behave the same on every platform.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.autocrlf',
    GIT_CONFIG_VALUE_0: 'false',
  }
}

/** Run git inside the sandbox. */
async function git(
  args: string[],
  cwd: string,
  globalConfig = NULL_DEVICE,
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env: gitEnv(globalConfig),
  })
  return stdout.trim()
}

/**
 * Build a realistic repo: a bare "remote" plus a clone laid out the way `wt`
 * expects (<repo>/main), with the registry pre-populated.
 */
export async function createSandbox(name = 'demo'): Promise<Sandbox> {
  // realpath because macOS puts temp dirs behind the /tmp -> /private/tmp
  // symlink, and git reports worktree paths already resolved.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wt-test-')))
  const remote = join(root, `${name}.git`)
  const repoPath = join(root, 'code', name)
  const mainPath = join(repoPath, 'main')
  const reposFile = join(root, 'repos')

  await mkdir(remote, { recursive: true })
  await execFileAsync(
    'git',
    ['init', '--bare', '--initial-branch=main', remote],
    { env: gitEnv() },
  )

  const seed = join(root, 'seed')
  await mkdir(seed, { recursive: true })
  await execFileAsync('git', ['init', '--initial-branch=main', seed], {
    env: gitEnv(),
  })
  await git(['config', 'user.email', 'test@example.com'], seed)
  await git(['config', 'user.name', 'Test'], seed)
  await writeFile(join(seed, 'README.md'), '# demo\n')
  await git(['add', '.'], seed)
  await git(['commit', '-m', 'initial'], seed)
  await git(['remote', 'add', 'origin', remote], seed)
  await git(['push', '-u', 'origin', 'main'], seed)

  await mkdir(repoPath, { recursive: true })
  await execFileAsync('git', ['clone', remote, mainPath], { env: gitEnv() })
  await git(['config', 'user.email', 'test@example.com'], mainPath)
  await git(['config', 'user.name', 'Test'], mainPath)
  await git(['remote', 'set-head', 'origin', '--auto'], mainPath)

  await writeFile(reposFile, `${name} ${repoPath}\n`)

  return {
    root,
    remote,
    repoPath,
    mainPath,
    reposFile,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  json: <T = unknown>() => T
}

/**
 * Run the CLI in-process via tsx-less loading is not available, so shell out
 * to node with the TypeScript entry compiled on the fly by vite-node.
 */
export async function runCli(
  args: string[],
  sandbox: Sandbox,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // HOME is redirected so the CLI reads a sandboxed ~/.config/grove and
    // never picks up (or writes to) the developer's real configuration.
    HOME: sandbox.root,
    USERPROFILE: sandbox.root,
    GROVE_REPOS_FILE: sandbox.reposFile,
    GROVE_BRANCH_PREFIX: 'test/',
    GROVE_DEFAULT_CODE_DIR: join(sandbox.root, 'code'),
    // Point git's global config at the sandbox HOME rather than the null device,
    // so `profile apply` writes somewhere git will actually read back.
    GIT_CONFIG_GLOBAL: join(sandbox.root, '.gitconfig'),
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    // Keep the CLI's own git calls on LF endings; see gitEnv above.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.autocrlf',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...extraEnv,
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI, ...args],
      { env, cwd: extraEnv['PWD'] ?? sandbox.root },
    )
    return makeResult(stdout, stderr, 0)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number }
    return makeResult(err.stdout ?? '', err.stderr ?? '', err.code ?? 1)
  }
}

function makeResult(stdout: string, stderr: string, exitCode: number): RunResult {
  return {
    stdout,
    stderr,
    exitCode,
    json: <T,>() => JSON.parse(stdout) as T,
  }
}

/**
 * Run the CLI with stdin pretending to be a TTY, so interactive prompts
 * actually render, and answer the first prompt with Enter. Used to assert
 * which stream prompts are drawn on; stdout and stderr stay separate pipes.
 */
export async function runCliWithTty(
  args: string[],
  sandbox: Sandbox,
  extraEnv: NodeJS.ProcessEnv = {},
  { answerAfterMs = 1500, timeoutMs = 15_000 } = {},
): Promise<RunResult> {
  // A loader that flips isTTY before handing off to the real bundle. argv[1]
  // is rewritten so the CLI's own argv parsing lines up as if run directly.
  const shim = join(sandbox.root, 'tty-shim.mjs')
  await writeFile(
    shim,
    [
      `process.stdin.isTTY = true`,
      `process.stdin.setRawMode = () => process.stdin`,
      `process.argv.splice(1, 1, ${JSON.stringify(CLI)})`,
      // A bare path is not a valid ESM specifier on Windows, where it reads
      // as a URL with a "c:" scheme; import via a file:// URL instead.
      `await import(${JSON.stringify(pathToFileURL(CLI).href)})`,
    ].join('\n'),
  )

  const child = spawn(process.execPath, [shim, ...args], {
    cwd: sandbox.root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: sandbox.root,
      USERPROFILE: sandbox.root,
      GROVE_REPOS_FILE: sandbox.reposFile,
      GROVE_DEFAULT_CODE_DIR: join(sandbox.root, 'code'),
      GIT_CONFIG_GLOBAL: join(sandbox.root, '.gitconfig'),
      GIT_CONFIG_SYSTEM: NULL_DEVICE,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      ...extraEnv,
    },
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))

  // Accept the prompt's default. A carriage return is what a real terminal
  // sends in raw mode, which is what clack is listening for.
  const answer = setTimeout(() => child.stdin.write('\r'), answerAfterMs)
  const abort = setTimeout(() => child.kill('SIGKILL'), timeoutMs)

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1))
  })
  clearTimeout(answer)
  clearTimeout(abort)

  return makeResult(stdout, stderr, exitCode)
}

export { git as gitIn }

/** Run git with the sandbox's generated global config in effect. */
export function gitWithGlobalConfig(
  sandbox: Sandbox,
): (args: string[], cwd: string) => Promise<string> {
  return (args, cwd) => git(args, cwd, join(sandbox.root, '.gitconfig'))
}
