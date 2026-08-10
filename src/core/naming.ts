/** Lowercase, strip punctuation, collapse to dashes, cap at 50 chars. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-$/, '')
}

/** Pull the first Jira-style key (e.g. GRAPHYTE-2469) out of a string. */
export function extractJiraKey(input: string): string | undefined {
  const match = /\b[A-Z][A-Z0-9]+-\d+\b/.exec(input.toUpperCase())
  return match?.[0]
}

/** yymmdd, used to prefix worktree folder names. */
export function datePrefix(date = new Date()): string {
  const yy = String(date.getFullYear()).slice(2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

export interface NameInputs {
  title: string
  jiraKey?: string | undefined
  branchPrefix: string
  date?: Date
}

export interface GeneratedNames {
  slug: string
  branch: string
  worktreeDir: string
  workspaceTitle: string
}

/**
 * Build the branch and folder names for a new worktree.
 *
 *   branch:   <prefix><KEY->-<slug>     e.g. jake/ABC-1-fix-thing
 *   worktree: <yymmdd>-<slug>[-KEY]     e.g. 260810-fix-thing-ABC-1
 */
export function generateNames({
  title,
  jiraKey,
  branchPrefix,
  date,
}: NameInputs): GeneratedNames {
  const slug = slugify(stripJiraKey(title, jiraKey))
  if (!slug) {
    throw new Error('Title must contain at least one letter or number.')
  }
  const prefix = datePrefix(date)

  if (jiraKey) {
    return {
      slug,
      branch: `${branchPrefix}${jiraKey}-${slug}`,
      worktreeDir: `${prefix}-${slug}-${jiraKey}`,
      workspaceTitle: `${jiraKey} • ${title}`,
    }
  }
  return {
    slug,
    branch: `${branchPrefix}${slug}`,
    worktreeDir: `${prefix}-${slug}`,
    workspaceTitle: title,
  }
}

/** Remove the Jira key from a title so it is not duplicated in the slug. */
export function stripJiraKey(title: string, jiraKey?: string): string {
  if (!jiraKey) return title
  const escaped = jiraKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return title.replace(new RegExp(escaped, 'gi'), '').replace(/^[\s\-:]+|[\s\-:]+$/g, '')
}

/** Folder name for an existing branch checked out into a worktree. */
export function worktreeDirForBranch(branch: string, date = new Date()): string {
  // Drop a leading owner segment (jake/foo -> foo) to keep folders short.
  const withoutOwner = branch.includes('/')
    ? branch.slice(branch.indexOf('/') + 1)
    : branch
  const slug = slugify(withoutOwner) || slugify(branch) || 'branch'
  return `${datePrefix(date)}-${slug}`
}

/** Extract a repo name from a clone URL, handling ssh, https, and scp forms. */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  const lastSlash = cleaned.lastIndexOf('/')
  const lastColon = cleaned.lastIndexOf(':')
  const cut = Math.max(lastSlash, lastColon)
  const name = cut >= 0 ? cleaned.slice(cut + 1) : cleaned
  if (!name) {
    throw new Error(`Could not determine a repo name from URL: ${url}`)
  }
  return name
}
