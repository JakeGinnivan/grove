/**
 * A user-facing error. These are reported as a clean message rather than a
 * stack trace, and carry an exit code plus a stable machine-readable code so
 * `--json` consumers (agents) can branch on the failure.
 */
export class WtError extends Error {
  readonly code: string
  readonly exitCode: number
  readonly hint: string | undefined

  constructor(
    message: string,
    options: { code?: string; exitCode?: number; hint?: string } = {},
  ) {
    super(message)
    this.name = 'WtError'
    this.code = options.code ?? 'wt_error'
    this.exitCode = options.exitCode ?? 1
    this.hint = options.hint
  }
}

/** Thrown when an interactive prompt is cancelled (ctrl-c). Exits quietly. */
export class CancelledError extends WtError {
  constructor(message = 'Cancelled.') {
    super(message, { code: 'cancelled', exitCode: 130 })
    this.name = 'CancelledError'
  }
}

/**
 * Thrown when a command needs input that was not supplied and the process
 * cannot prompt for it (non-TTY, or --no-interactive / --json).
 */
export class NeedsInputError extends WtError {
  constructor(what: string, flag: string) {
    super(`${what} is required in non-interactive mode.`, {
      code: 'needs_input',
      exitCode: 2,
      hint: `Pass ${flag}, or run in an interactive terminal.`,
    })
    this.name = 'NeedsInputError'
  }
}
