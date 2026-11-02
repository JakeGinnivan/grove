import { describe, it, expect } from 'vitest'
import { githubOwnerOf, groupOwners } from '../src/core/github.js'

describe('githubOwnerOf', () => {
  it.for([
    ['git@github.com:ginnivan/grove.git', 'ginnivan'],
    ['https://github.com/JakeGinnivan/grove.git', 'JakeGinnivan'],
    ['https://github.com/JakeGinnivan/grove', 'JakeGinnivan'],
    ['ssh://git@github.com/acme/thing.git', 'acme'],
  ])('reads the owner from %s', ([url, owner]) => {
    expect(githubOwnerOf(url!)).toBe(owner)
  })

  it('ignores remotes that are not on GitHub', () => {
    expect(githubOwnerOf('git@gitlab.com:acme/thing.git')).toBeUndefined()
    expect(githubOwnerOf('/Users/me/seed')).toBeUndefined()
  })
})

describe('groupOwners', () => {
  const available = { login: 'me', orgs: ['zeta', 'Acme', 'ginnivan'] }

  it('keeps your own account apart, however much it is used', () => {
    const groups = groupOwners(available, ['me', 'me', 'me'])
    expect(groups.you).toEqual({ owner: 'me', localRepos: 3 })
    expect(groups.used).toEqual([])
    expect(groups.other).toEqual(['Acme', 'ginnivan', 'zeta'])
  })

  it('lists orgs with local repos as used, most repos first', () => {
    const groups = groupOwners(available, ['zeta', 'ginnivan', 'ginnivan'])
    expect(groups.used).toEqual([
      { owner: 'ginnivan', localRepos: 2 },
      { owner: 'zeta', localRepos: 1 },
    ])
    expect(groups.other).toEqual(['Acme'])
  })

  it('puts recently created-under orgs first, latest first', () => {
    const groups = groupOwners(available, ['ginnivan', 'ginnivan'], ['Acme', 'me', 'zeta'])
    expect(groups.used.map((u) => u.owner)).toEqual(['Acme', 'zeta', 'ginnivan'])
  })

  it('matches owners case-insensitively, as GitHub does', () => {
    const groups = groupOwners(available, ['acme'], ['ZETA'])
    expect(groups.used.map((u) => u.owner)).toEqual(['zeta', 'Acme'])
  })

  it('drops owners seen only in remotes, which cannot be created under', () => {
    const groups = groupOwners(available, ['facebook', 'facebook'])
    expect(groups.used).toEqual([])
    expect(groups.other).toEqual(['Acme', 'ginnivan', 'zeta'])
  })
})
