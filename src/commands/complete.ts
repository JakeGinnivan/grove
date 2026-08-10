import { Command } from 'commander'
import { basename } from 'node:path'
import { loadConfig, profileList } from '../core/config.js'
import { readRegistry, gitDirFor, resolveRepo } from '../core/registry.js'
import { listWorktrees, git } from '../core/git.js'

/**
 * Machine-readable completion data for shell integration.
 *
 * Output is one candidate per line as `value<TAB>description`, which is the
 * format zsh's _describe, bash, fish, and PowerShell can all consume. Errors
 * are swallowed: a completion must never print noise into the user's prompt.
 */
export function completeCommand(): Command {
  const command = new Command('__complete')
    .description('Internal: emit completion candidates')
    .argument('<what>', 'repos | worktrees | profiles | branches')
    .argument('[repo]', 'repo name, where the candidate list depends on it')
    .action(async (what: string, repo: string | undefined) => {
      try {
        const lines = await candidates(what, repo)
        if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`)
      } catch {
        // Silence is the correct failure mode for a completion helper.
      }
    })

  // Completions are invoked constantly; never let commander print help or
  // exit non-zero into the user's terminal.
  command.exitOverride(() => {
    throw new Error('completion')
  })
  return command
}

async function candidates(
  what: string,
  repo: string | undefined,
): Promise<string[]> {
  const config = await loadConfig()

  switch (what) {
    case 'repos': {
      const entries = await readRegistry(config.reposFile)
      return entries.map((entry) =>
        entry.aliasOf
          ? `${entry.name}\talias for ${entry.aliasOf}`
          : `${entry.name}\t${entry.path}`,
      )
    }

    case 'profiles': {
      return profileList(config).map(
        (profile) => `${profile.name}\t${profile.description ?? profile.dir}`,
      )
    }

    case 'worktrees': {
      if (!repo) return []
      const entry = await resolveRepo(config.reposFile, repo)
      const gitDir = await gitDirFor(entry.path)
      const worktrees = await listWorktrees(gitDir)
      return worktrees.map(
        (wt) => `${basename(wt.path)}\t${wt.branch ?? 'detached'}`,
      )
    }

    case 'branches': {
      if (!repo) return []
      const entry = await resolveRepo(config.reposFile, repo)
      const gitDir = await gitDirFor(entry.path)
      const worktrees = await listWorktrees(gitDir)
      const checkedOut = new Set(
        worktrees.map((wt) => wt.branch).filter(Boolean) as string[],
      )
      // Exclude symbolic refs so origin/HEAD does not surface as "origin".
      const { stdout } = await git(
        [
          'for-each-ref',
          '--format=%(refname:short)',
          '--exclude=refs/remotes/*/HEAD',
          'refs/heads',
          'refs/remotes/origin',
        ],
        { cwd: gitDir, allowFailure: true },
      )
      const seen = new Set<string>()
      const branches: string[] = []
      for (const raw of stdout.split('\n')) {
        const name = raw.replace(/^origin\//, '')
        if (!name || name === 'HEAD' || seen.has(name)) continue
        seen.add(name)
        branches.push(
          `${name}\t${checkedOut.has(name) ? 'already checked out' : 'branch'}`,
        )
      }
      return branches
    }

    default:
      return []
  }
}
