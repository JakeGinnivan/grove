import * as clack from '@clack/prompts'
import { GroupMultiSelectPrompt } from '@clack/core'
import { styleText } from 'node:util'
import { CancelledError, NeedsInputError } from './errors.js'
import { getOutputContext } from './output.js'

/**
 * Every prompt renders to stderr. The shell wrapper captures stdout with
 * `$(...)` to read the cd sentinel, so anything clack wrote there would be
 * swallowed (an invisible prompt) and would corrupt the sentinel line.
 */
const PROMPT_STREAM = { output: process.stderr }

/**
 * clack styles prompts with `util.styleText`, which decides whether to emit
 * ANSI codes by inspecting `process.stdout` — but the `wt` wrapper captures
 * stdout with `$(...)`, so it is a pipe and styling gets stripped. The prompt
 * itself goes to stderr, which is still a TTY, so the text arrives unstyled:
 * no inverse block for the cursor and no dim placeholder. Opt back in when
 * stderr can show colour and the user has not asked otherwise.
 */
function enablePromptColour(): void {
  if (process.env.NO_COLOR || process.env.FORCE_COLOR) return
  if (process.stderr.isTTY === true) process.env.FORCE_COLOR = '1'
}

/** True when we may prompt: a TTY, not --json, not --no-interactive. */
export function canPrompt(): boolean {
  const { interactive } = getOutputContext()
  const ok = interactive && process.stdin.isTTY === true
  if (ok) enablePromptColour()
  return ok
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
      ...PROMPT_STREAM,
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
    initialValue?: string
    validate?: (value: string) => string | undefined
  },
): Promise<string | undefined> {
  if (provided !== undefined) return provided === '' ? undefined : provided
  if (!canPrompt()) return undefined

  const answer = guard(
    await clack.text({
      ...PROMPT_STREAM,
      message: options.message,
      placeholder: options.placeholder,
      initialValue: options.initialValue,
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
      ...PROMPT_STREAM,
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
  initialValue?: string,
): Promise<string> {
  if (options.length === 0) {
    throw new CancelledError('Nothing to select.')
  }
  if (!canPrompt()) {
    throw new NeedsInputError(what, 'the value as an argument')
  }
  return guard(
    await clack.select({
      ...PROMPT_STREAM,
      message,
      options,
      ...(initialValue !== undefined ? { initialValue } : {}),
    }),
  )
}

/**
 * Like `select`, but with a type-to-filter input in front of the list.
 *
 * Repos routinely carry hundreds of branches, which is more than a plain
 * select can usefully scroll. The filter matches anywhere in the label or
 * hint, so a partial branch name or a word from the commit subject both
 * narrow the list.
 */
export async function searchSelect(
  message: string,
  options: SelectOption[],
  what = 'A selection',
  extra: {
    placeholder?: string
    initialValue?: string
    /** Rows visible at once; the rest scroll into view. */
    maxItems?: number
  } = {},
): Promise<string> {
  if (options.length === 0) {
    throw new CancelledError('Nothing to select.')
  }
  if (!canPrompt()) {
    throw new NeedsInputError(what, 'the value as an argument')
  }
  return guard(
    await clack.autocomplete({
      ...PROMPT_STREAM,
      message,
      options,
      maxItems: extra.maxItems ?? 10,
      ...(extra.placeholder ? { placeholder: extra.placeholder } : {}),
      ...(extra.initialValue ? { initialValue: extra.initialValue } : {}),
      filter: (search, option) => {
        const needle = search.trim().toLowerCase()
        if (!needle) return true
        const haystack = `${option.label ?? option.value} ${option.hint ?? ''}`
        return haystack.toLowerCase().includes(needle)
      },
    }),
  )
}

export async function multiselect(
  message: string,
  options: SelectOption[],
  what = 'A selection',
  initialValues?: string[],
): Promise<string[]> {
  if (options.length === 0) return []
  if (!canPrompt()) {
    throw new NeedsInputError(what, 'the values as arguments')
  }
  return guard(
    await clack.multiselect({
      ...PROMPT_STREAM,
      message,
      options,
      required: false,
      ...(initialValues ? { initialValues } : {}),
    }),
  )
}

/**
 * A multiselect split under group headings. Keys of `groups` are the
 * headings; toggling a heading toggles every option under it, and `a`
 * toggles every option. Empty groups are dropped so no heading appears with
 * nothing beneath it.
 */
export async function groupMultiselect(
  message: string,
  groups: Record<string, SelectOption[]>,
  what = 'A selection',
  initialValues?: string[],
): Promise<string[]> {
  const nonEmpty = Object.fromEntries(
    Object.entries(groups).filter(([, options]) => options.length > 0),
  )
  if (Object.keys(nonEmpty).length === 0) return []
  if (!canPrompt()) {
    throw new NeedsInputError(what, 'the values as arguments')
  }
  const pending = withNextGroupPrompt(bindToggleAll, () =>
    clack.groupMultiselect({
      ...PROMPT_STREAM,
      message,
      options: nonEmpty,
      required: false,
      ...(initialValues ? { initialValues } : {}),
    }),
  )
  return guard(await pending)
}

/**
 * clack's flat multiselect binds `a` to select all / none, and we bind it on
 * the grouped one, but clack's key footer never lists it. Both prompts render
 * this shared, exported array, so add the key to it, before `Enter`. Styled
 * with `styleText` at load time, as clack builds its own entries.
 */
function addToggleAllInstruction(): void {
  const instructions = clack.MULTISELECT_INSTRUCTIONS
  const enter = instructions.findIndex((line) => line.includes('Enter:'))
  instructions.splice(
    enter === -1 ? instructions.length : enter,
    0,
    `${styleText('dim', 'a:')} all / none`,
  )
}
addToggleAllInstruction()

/**
 * Run `open` with `setup` applied to the group multiselect it constructs.
 * clack's `groupMultiselect` builds the prompt and calls `prompt()` on it in
 * one synchronous step and never hands the instance back, so the only way to
 * reach it is to intercept that call.
 */
function withNextGroupPrompt<T>(
  setup: (prompt: GroupMultiSelectPrompt<{ value: string }>) => void,
  open: () => T,
): T {
  const proto = GroupMultiSelectPrompt.prototype
  const original = proto.prompt
  proto.prompt = function (this: GroupMultiSelectPrompt<{ value: string }>) {
    proto.prompt = original
    setup(this)
    return original.call(this)
  }
  try {
    return open()
  } finally {
    proto.prompt = original
  }
}

/**
 * Give the group multiselect the `a` key its flat sibling has: select every
 * option, or clear them all when every one is already selected.
 */
function bindToggleAll(prompt: GroupMultiSelectPrompt<{ value: string }>): void {
  prompt.on('key', (_char, key) => {
    if (key?.name !== 'a') return
    const values = prompt.options
      .filter((option) => option.group !== true)
      .map((option) => option.value)
    const selected = prompt.value ?? []
    const all = values.every((value) => selected.includes(value))
    prompt.value = all ? [] : values
  })
}

export const spinner =(options: Parameters<typeof clack.spinner>[0] = {}) =>
  clack.spinner({ ...PROMPT_STREAM, ...options })
export const intro = (title: string) => {
  if (canPrompt()) clack.intro(title, PROMPT_STREAM)
}
export const outro = (message: string) => {
  if (canPrompt()) clack.outro(message, PROMPT_STREAM)
}
