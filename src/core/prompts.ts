import * as clack from '@clack/prompts'
import { CancelledError, NeedsInputError } from './errors.js'
import { getOutputContext } from './output.js'

/** True when we may prompt: a TTY, not --json, not --no-interactive. */
export function canPrompt(): boolean {
  const { interactive } = getOutputContext()
  return interactive && process.stdin.isTTY === true
}

function guard<T>(value: T | symbol): T {
  if (clack.isCancel(value)) throw new CancelledError()
  return value as T
}

/**
 * Return `provided` when set; otherwise prompt, or fail with a message
 * naming the flag the caller should have passed.
 */
export async function requireText(
  provided: string | undefined,
  options: {
    message: string
    flag: string
    what: string
    placeholder?: string
    initialValue?: string
    validate?: (value: string) => string | undefined
  },
): Promise<string> {
  if (provided !== undefined && provided !== '') {
    const problem = options.validate?.(provided)
    if (problem) throw new NeedsInputError(problem, options.flag)
    return provided
  }
  if (!canPrompt()) throw new NeedsInputError(options.what, options.flag)

  const answer = guard(
    await clack.text({
      message: options.message,
      placeholder: options.placeholder,
      initialValue: options.initialValue,
      validate: (value) => {
        if (!value || !value.trim()) return `${options.what} is required.`
        return options.validate?.(value.trim())
      },
    }),
  )
  return answer.trim()
}

/** Optional free-text prompt; returns undefined when skipped or empty. */
export async function optionalText(
  provided: string | undefined,
  options: {
    message: string
    placeholder?: string
    validate?: (value: string) => string | undefined
  },
): Promise<string | undefined> {
  if (provided !== undefined) return provided === '' ? undefined : provided
  if (!canPrompt()) return undefined

  const answer = guard(
    await clack.text({
      message: options.message,
      placeholder: options.placeholder,
      validate: (value) => {
        if (!value || !value.trim()) return undefined
        return options.validate?.(value.trim())
      },
    }),
  )
  const trimmed = answer.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Confirm a destructive action. When we cannot prompt, `assumeYes` decides:
 * callers pass the value of --yes/--force so agents must opt in explicitly.
 */
export async function confirm(
  message: string,
  options: { assumeYes: boolean; defaultValue?: boolean; what?: string },
): Promise<boolean> {
  if (options.assumeYes) return true
  if (!canPrompt()) {
    throw new NeedsInputError(
      options.what ?? 'Confirmation',
      '--yes to proceed without confirmation',
    )
  }
  return guard(
    await clack.confirm({
      message,
      initialValue: options.defaultValue ?? false,
    }),
  )
}

/**
 * clack's Option type is conditional on the value being a primitive, which
 * does not resolve against an unbound generic. Selections here are always
 * keyed by string, so the option type is concrete.
 */
export interface SelectOption {
  value: string
  label: string
  hint?: string | undefined
}

export async function select(
  message: string,
  options: SelectOption[],
  what = 'A selection',
): Promise<string> {
  if (options.length === 0) {
    throw new CancelledError('Nothing to select.')
  }
  if (!canPrompt()) {
    throw new NeedsInputError(what, 'the value as an argument')
  }
  return guard(await clack.select({ message, options }))
}

export async function multiselect(
  message: string,
  options: SelectOption[],
  what = 'A selection',
): Promise<string[]> {
  if (options.length === 0) return []
  if (!canPrompt()) {
    throw new NeedsInputError(what, 'the values as arguments')
  }
  return guard(
    await clack.multiselect({ message, options, required: false }),
  )
}

export const spinner = clack.spinner
export const intro = (title: string) => {
  if (canPrompt()) clack.intro(title)
}
export const outro = (message: string) => {
  if (canPrompt()) clack.outro(message)
}
