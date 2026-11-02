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

  it('lists owners with local repos first, most repos first', () => {
    const groups = groupOwners(available, ['me', 'ginnivan', 'ginnivan', 'me', 'ginnivan'])
    expect(groups.used).toEqual([
      { owner: 'ginnivan', localRepos: 3 },
      { owner: 'me', localRepos: 2 },
    ])
    expect(groups.other).toEqual(['Acme', 'zeta'])
  })

  it('matches owners case-insensitively, as GitHub does', () => {
    const groups = groupOwners(available, ['acme'])
    expect(groups.used).toEqual([{ owner: 'Acme', localRepos: 1 }])
  })

  it('drops owners seen only in remotes, which cannot be created under', () => {
    const groups = groupOwners(available, ['facebook', 'facebook'])
    expect(groups.used).toEqual([])
    expect(groups.other).toEqual(['me', 'Acme', 'ginnivan', 'zeta'])
  })

  it('puts the last owner created under first, even with fewer repos', () => {
    const groups = groupOwners(available, ['me', 'me', 'me'], 'zeta')
    expect(groups.used.map((u) => u.owner)).toEqual(['zeta', 'me'])
  })
})
