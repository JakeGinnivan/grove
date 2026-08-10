import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WtError } from './errors.js'
import { isGitRepo } from './git.js'

export interface RepoEntry {
  /** Canonical repo name, or the alias the user typed. */
  name: string
  /** Parent directory holding the worktrees (contains `main/`). */
  path: string
  /** Set when `name` is an alias pointing at another entry. */
  aliasOf?: string
}

/**
 * The registry file format is line-based and shared with the original zsh
 * helper, so existing ~/.wt_repos files keep working:
 *
 *   # comment
 *   my-repo /Users/you/_code/my-repo
 *   mr my-repo            <- alias
 */
export async function readRegistry(reposFile: string): Promise<RepoEntry[]> {
  if (!existsSync(reposFile)) return []
  const content = await readFile(reposFile, 'utf8')
  const raw = new Map<string, string>()

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^(\S+)\s+(.+)$/.exec(trimmed)
    if (!match) continue
    const [, key, value] = match
    if (key && value) raw.set(key, value.trim())
  }

  const entries: RepoEntry[] = []
  for (const [key, value] of raw) {
    if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
      entries.push({ name: key, path: value })
    } else {
      const target = raw.get(value)
      // An alias is only valid when it resolves to a real path entry.
      if (target?.startsWith('/') || (target && /^[A-Za-z]:[\\/]/.test(target))) {
        entries.push({ name: key, path: target, aliasOf: value })
      }
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve a repo name or alias to its entry, or throw a helpful error. */
export async function resolveRepo(
  reposFile: string,
  name: string,
): Promise<RepoEntry> {
  const entries = await readRegistry(reposFile)
  const found = entries.find((entry) => entry.name === name)
  if (found) return found

  const available = entries.map((entry) => entry.name)
  throw new WtError(`Unknown repo: ${name}`, {
    code: 'unknown_repo',
    hint: available.length
      ? `Available: ${available.join(', ')}`
      : 'No repos registered yet. Use `wt clone <url>` or `wt repos add <path>`.',
  })
}

/**
 * Locate the git directory for a registered repo. Worktree-style layouts keep
 * the primary checkout in `<repo>/main`, but a plain clone is also supported.
 */
export async function gitDirFor(repoPath: string): Promise<string> {
  if (await isGitRepo(repoPath)) return repoPath
  const mainDir = join(repoPath, 'main')
  if (await isGitRepo(mainDir)) return mainDir
  throw new WtError(`No git repo found in ${repoPath} or ${mainDir}`, {
    code: 'no_git_repo',
  })
}

/** Add or replace a repo entry (and optional alias) in the registry file. */
export async function writeRepo(
  reposFile: string,
  repoName: string,
  repoPath: string,
  alias?: string,
): Promise<void> {
  await mkdir(dirname(reposFile), { recursive: true })
  const existing = existsSync(reposFile)
    ? await readFile(reposFile, 'utf8')
    : ''

  // Drop any prior definition of this repo, its aliases, and the comment
  // line that precedes them, so re-registering stays idempotent.
  const kept: string[] = []
  const lines = existing.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (!trimmed) {
      kept.push(line)
      continue
    }
    if (trimmed.startsWith('#')) {
      const next = (lines[i + 1] ?? '').trim()
      const nextKey = next.split(/\s+/)[0]
      const nextValue = next.split(/\s+/)[1]
      if (nextKey === repoName || nextValue === repoName) continue
      kept.push(line)
      continue
    }
    const [key, value] = trimmed.split(/\s+/)
    if (key === repoName || value === repoName) continue
    if (alias && key === alias) continue
    kept.push(line)
  }

  const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  const date = new Date().toISOString().slice(0, 10)
  const block = [
    `# ${repoName} (registered ${date})`,
    `${repoName} ${repoPath}`,
    ...(alias ? [`${alias} ${repoName}`] : []),
  ].join('\n')

  const output = body ? `${body}\n\n${block}\n` : `${block}\n`
  await writeFile(reposFile, output, 'utf8')
}

/** Remove a repo and any aliases pointing at it. */
export async function removeRepo(
  reposFile: string,
  repoName: string,
): Promise<void> {
  if (!existsSync(reposFile)) return
  const content = await readFile(reposFile, 'utf8')
  const lines = content.split('\n')
  const kept: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) {
      const next = (lines[i + 1] ?? '').trim()
      const nextKey = next.split(/\s+/)[0]
      const nextValue = next.split(/\s+/)[1]
      if (nextKey === repoName || nextValue === repoName) continue
      kept.push(line)
      continue
    }
    const [key, value] = trimmed.split(/\s+/)
    if (key === repoName || value === repoName) continue
    kept.push(line)
  }

  const output = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  await writeFile(reposFile, output ? `${output}\n` : '', 'utf8')
}
