import { extractJiraKey } from './naming.js'

export const TASK_TRACKER_IDS = ['jira', 'linear', 'github'] as const
export type TaskTrackerId = (typeof TASK_TRACKER_IDS)[number]

export interface TaskTracker {
  id: TaskTrackerId
  label: string
  example: string
  /** Find a key mentioned in prose, such as a title. Must not fire on ordinary words or numbers. */
  find(text: string): string | undefined
  /** Read a value typed as an issue key, where a looser form is unambiguous. */
  parse(input: string): string | undefined
}

/** GitHub issues are plain numbers, so in prose only `#123` counts. */
function findGitHubNumber(text: string): string | undefined {
  return /(?:^|[^\w&])#(\d+)\b/.exec(text)?.[1]
}

function parseGitHubNumber(input: string): string | undefined {
  const trimmed = input.trim()
  return (
    /^#?(\d+)$/.exec(trimmed)?.[1] ??
    /github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/(\d+)/.exec(trimmed)?.[1] ??
    findGitHubNumber(trimmed)
  )
}

export const TASK_TRACKERS: Record<TaskTrackerId, TaskTracker> = {
  jira: {
    id: 'jira',
    label: 'Jira',
    example: 'ABC-123',
    find: extractJiraKey,
    parse: extractJiraKey,
  },
  // Same key shape as Jira; listed separately so the prompt names it.
  linear: {
    id: 'linear',
    label: 'Linear',
    example: 'ABC-123',
    find: extractJiraKey,
    parse: extractJiraKey,
  },
  github: {
    id: 'github',
    label: 'GitHub Issues',
    example: '#123',
    find: findGitHubNumber,
    parse: parseGitHubNumber,
  },
}

export interface Issue {
  tracker: TaskTrackerId
  key: string
}

export function isTaskTrackerId(value: string): value is TaskTrackerId {
  return (TASK_TRACKER_IDS as readonly string[]).includes(value)
}

/** The configured trackers in configured order, ignoring unknown ids. */
export function enabledTrackers(ids: readonly string[]): TaskTracker[] {
  return [...new Set(ids)].filter(isTaskTrackerId).map((id) => TASK_TRACKERS[id])
}

/** First tracker, in order, that recognises a key in the title. */
export function findIssue(text: string, trackers: TaskTracker[]): Issue | undefined {
  for (const tracker of trackers) {
    const key = tracker.find(text)
    if (key) return { tracker: tracker.id, key }
  }
  return undefined
}

/** First tracker, in order, that accepts a typed key. */
export function parseIssue(input: string, trackers: TaskTracker[]): Issue | undefined {
  for (const tracker of trackers) {
    const key = tracker.parse(input)
    if (key) return { tracker: tracker.id, key }
  }
  return undefined
}

/** "ABC-123 or #123", deduplicating trackers that share a key shape. */
export function describeFormats(trackers: TaskTracker[]): string {
  return [...new Set(trackers.map((tracker) => tracker.example))].join(' or ')
}

/** Parse a `--task-trackers` value: comma-separated ids, or `none`. */
export function parseTrackerList(value: string): TaskTrackerId[] | string {
  const parts = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length === 1 && parts[0] === 'none') return []
  const unknown = parts.filter((part) => !isTaskTrackerId(part))
  if (unknown.length > 0) {
    return `Unknown task tracker: ${unknown.join(', ')}. Expected ${TASK_TRACKER_IDS.join(', ')}, or none.`
  }
  return [...new Set(parts)] as TaskTrackerId[]
}
