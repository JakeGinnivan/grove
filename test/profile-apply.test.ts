import { describe, it, expect } from 'vitest'
import {
  globalIncludeBlock,
  mergeClaudePermissions,
  outermostDirs,
  spliceManagedBlock,
} from '../src/core/profile-apply.js'

const BLOCK = '# >>> grove managed >>>\nmanaged\n# <<< grove managed <<<\n'
const NEWER = '# >>> grove managed >>>\nnewer\n# <<< grove managed <<<\n'

describe('spliceManagedBlock', () => {
  it('writes the block into an empty file', () => {
    expect(spliceManagedBlock('', BLOCK)).toBe(BLOCK)
  })

  it('appends after hand-written config, keeping it', () => {
    expect(spliceManagedBlock('[user]\n\tname = Someone', BLOCK)).toBe(
      `[user]\n\tname = Someone\n\n${BLOCK}`,
    )
  })

  it('replaces its own block in place rather than adding another', () => {
    const once = spliceManagedBlock('[user]\n\tname = Someone\n', BLOCK)
    expect(spliceManagedBlock(once, BLOCK)).toBe(once)
    expect(spliceManagedBlock(once, NEWER)).toBe(`[user]\n\tname = Someone\n\n${NEWER}`)
  })

  it('removes its block without touching config either side of it', () => {
    const file = `[user]\n\tname = Someone\n\n${BLOCK}\n[core]\n\teditor = vim\n`
    expect(spliceManagedBlock(file, '')).toBe(
      '[user]\n\tname = Someone\n\n[core]\n\teditor = vim\n',
    )
  })

  it('leaves a file with no block alone when removing', () => {
    expect(spliceManagedBlock('[user]\n', '')).toBe('[user]\n')
  })
})

describe('globalIncludeBlock', () => {
  it('is empty with no profiles, so applying it clears an old block', () => {
    expect(globalIncludeBlock([])).toBe('')
  })

  it('includes each profile config under its directory, in forward slashes', () => {
    const block = globalIncludeBlock([{ name: 'work', dir: 'C:\\code\\work' }])
    expect(block).toContain('[includeIf "gitdir:C:/code/work/"]')
    expect(block).toContain('\tpath = C:/code/work/.gitconfig')
  })
})

describe('outermostDirs', () => {
  it('drops duplicates and directories inside another', () => {
    expect(outermostDirs(['/code/work/team', '/code/oss', '/code/work', '/code/oss'])).toEqual([
      '/code/oss',
      '/code/work',
    ])
  })

  it('keeps a sibling that only shares a name prefix', () => {
    expect(outermostDirs(['/code/work', '/code/workshop'])).toEqual([
      '/code/work',
      '/code/workshop',
    ])
  })
})

describe('mergeClaudePermissions', () => {
  const none = { additionalDirectories: [], allow: [] }

  it('adds read access, keeping every other setting', () => {
    const { settings, managed } = mergeClaudePermissions(
      { model: 'opus', permissions: { allow: ['Bash(ls:*)'], defaultMode: 'auto' } },
      ['/code/work'],
      none,
    )
    expect(settings).toEqual({
      model: 'opus',
      permissions: {
        additionalDirectories: ['/code/work'],
        allow: ['Bash(ls:*)', 'Read(/code/work/**)'],
        defaultMode: 'auto',
      },
    })
    expect(managed).toEqual({
      additionalDirectories: ['/code/work'],
      allow: ['Read(/code/work/**)'],
    })
  })

  it('does not take ownership of a grant the user already made', () => {
    const { managed } = mergeClaudePermissions(
      { permissions: { additionalDirectories: ['/code/work'], allow: ['Read(/code/work/**)'] } },
      ['/code/work'],
      none,
    )
    expect(managed).toEqual(none)
  })

  it('revokes only the grants it made before', () => {
    const { settings, managed } = mergeClaudePermissions(
      {
        permissions: {
          additionalDirectories: ['/code/old', '/user-owned'],
          allow: ['Read(/code/old/**)', 'Read(/user-owned/**)'],
        },
      },
      [],
      { additionalDirectories: ['/code/old'], allow: ['Read(/code/old/**)'] },
    )
    expect(settings.permissions).toEqual({
      additionalDirectories: ['/user-owned'],
      allow: ['Read(/user-owned/**)'],
    })
    expect(managed).toEqual(none)
  })

  it('reaches the same settings when run again', () => {
    const first = mergeClaudePermissions({}, ['/code/work', '/code/oss'], none)
    const second = mergeClaudePermissions(first.settings, ['/code/work', '/code/oss'], first.managed)
    expect(second).toEqual(first)
  })
})
