import pc from 'picocolors'
import { WtError } from './errors.js'

/** Sentinel the shell wrapper looks for to change the parent shell's dir. */
export const CD_SENTINEL = '__WT_CD__'

export interface OutputContext {
  json: boolean
  interactive: boolean
}

let context: OutputContext = { json: false, interactive: false }

export function setOutputContext(next: OutputContext): void {
  context = next
}

export function getOutputContext(): OutputContext {
  return context
}

/**
 * Human-facing chatter. Always goes to stderr so that stdout stays a clean
 * channel for the cd sentinel and --json payloads.
 */
export function log(message = ''): void {
  if (context.json) return
  process.stderr.write(`${message}\n`)
}

export function success(message: string): void {
  log(`${pc.green('✓')} ${message}`)
}

export function warn(message: string): void {
  if (context.json) return
  process.stderr.write(`${pc.yellow('⚠')} ${message}\n`)
}

export function info(message: string): void {
  log(`${pc.dim('·')} ${message}`)
}

/** Emit the final machine-readable result on stdout. */
export function emitJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
}

/**
 * Ask the shell wrapper to cd. Without the wrapper installed the raw path is
 * still printed, which remains useful for `cd "$(wt ...)"`.
 */
export function emitCd(path: string): void {
  if (context.json) return
  if (process.env['GROVE_SHELL_INTEGRATION'] === '1') {
    process.stdout.write(`${CD_SENTINEL}${path}\n`)
  } else {
    process.stdout.write(`${path}\n`)
  }
}

export function reportError(error: unknown): number {
  if (error instanceof WtError) {
    if (context.json) {
      emitJson({
        ok: false,
        error: { code: error.code, message: error.message, hint: error.hint },
      })
    } else {
      process.stderr.write(`${pc.red('✗')} ${error.message}\n`)
      if (error.hint) process.stderr.write(`  ${pc.dim(error.hint)}\n`)
    }
    return error.exitCode
  }

  const message = error instanceof Error ? error.message : String(error)
  if (context.json) {
    emitJson({ ok: false, error: { code: 'internal', message } })
  } else {
    process.stderr.write(`${pc.red('✗')} ${message}\n`)
    if (error instanceof Error && error.stack && process.env['GROVE_DEBUG']) {
      process.stderr.write(`${pc.dim(error.stack)}\n`)
    }
  }
  return 1
}
