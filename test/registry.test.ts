import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readRegistry,
  writeRepo,
  removeRepo,
  resolveRepo,
} from '../src/core/registry.js'

let dir: string
let reposFile: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wt-registry-'))
  reposFile = join(dir, 'repos')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readRegistry', () => {
  it('returns empty for a missing file', async () => {
    expect(await readRegistry(join(dir, 'nope'))).toEqual([])
  })

  it('parses name/path pairs', async () => {
    await writeFile(reposFile, 'my-repo /code/my-repo\n')
    expect(await readRegistry(reposFile)).toEqual([
      { name: 'my-repo', path: '/code/my-repo' },
    ])
  })

  it('ignores comments and blank lines', async () => {
    await writeFile(reposFile, '# a comment\n\nmy-repo /code/my-repo\n\n')
    expect(await readRegistry(reposFile)).toHaveLength(1)
  })

  it('resolves aliases to the target path', async () => {
    await writeFile(reposFile, 'my-repo /code/my-repo\nmr my-repo\n')
    const entries = await readRegistry(reposFile)
    const alias = entries.find((entry) => entry.name === 'mr')
    expect(alias).toEqual({
      name: 'mr',
      path: '/code/my-repo',
      aliasOf: 'my-repo',
    })
  })

  it('drops aliases that point nowhere', async () => {
    await writeFile(reposFile, 'orphan missing-target\n')
    expect(await readRegistry(reposFile)).toEqual([])
  })

  it('handles paths containing spaces', async () => {
    await writeFile(reposFile, 'my-repo /code/my repo\n')
    const entries = await readRegistry(reposFile)
    expect(entries[0]?.path).toBe('/code/my repo')
  })
})

describe('writeRepo', () => {
  it('creates the file and writes an entry', async () => {
    await writeRepo(reposFile, 'my-repo', '/code/my-repo')
    const entries = await readRegistry(reposFile)
    expect(entries).toEqual([{ name: 'my-repo', path: '/code/my-repo' }])
  })

  it('writes an alias alongside the entry', async () => {
    await writeRepo(reposFile, 'my-repo', '/code/my-repo', 'mr')
    const entries = await readRegistry(reposFile)
    expect(entries.map((entry) => entry.name).sort()).toEqual(['mr', 'my-repo'])
  })

  it('replaces an existing entry rather than duplicating it', async () => {
    await writeRepo(reposFile, 'my-repo', '/code/old')
    await writeRepo(reposFile, 'my-repo', '/code/new')
    const entries = await readRegistry(reposFile)
    expect(entries).toEqual([{ name: 'my-repo', path: '/code/new' }])
  })

  it('replaces the alias too when re-registering', async () => {
    await writeRepo(reposFile, 'my-repo', '/code/my-repo', 'mr')
    await writeRepo(reposFile, 'my-repo', '/code/my-repo', 'mine')
    const entries = await readRegistry(reposFile)
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'mine',
      'my-repo',
    ])
  })

  it('preserves unrelated entries', async () => {
    await writeRepo(reposFile, 'one', '/code/one')
    await writeRepo(reposFile, 'two', '/code/two')
    const entries = await readRegistry(reposFile)
    expect(entries).toHaveLength(2)
  })

  it('does not accumulate blank lines', async () => {
    await writeRepo(reposFile, 'one', '/code/one')
    await writeRepo(reposFile, 'two', '/code/two')
    await writeRepo(reposFile, 'one', '/code/one-v2')
    const content = await readFile(reposFile, 'utf8')
    expect(content).not.toMatch(/\n{3,}/)
  })
})

describe('removeRepo', () => {
  it('removes the entry and its alias', async () => {
    await writeRepo(reposFile, 'my-repo', '/code/my-repo', 'mr')
    await removeRepo(reposFile, 'my-repo')
    expect(await readRegistry(reposFile)).toEqual([])
  })

  it('leaves other entries intact', async () => {
    await writeRepo(reposFile, 'one', '/code/one')
    await writeRepo(reposFile, 'two', '/code/two')
    await removeRepo(reposFile, 'one')
    const entries = await readRegistry(reposFile)
    expect(entries).toEqual([{ name: 'two', path: '/code/two' }])
  })
})

describe('resolveRepo', () => {
  it('resolves an alias to the underlying path', async () => {
    await writeRepo(reposFile, 'my-repo', '/code/my-repo', 'mr')
    const entry = await resolveRepo(reposFile, 'mr')
    expect(entry.path).toBe('/code/my-repo')
  })

  it('throws with available names listed', async () => {
    await writeRepo(reposFile, 'my-repo', '/code/my-repo')
    await expect(resolveRepo(reposFile, 'nope')).rejects.toThrow(
      /Unknown repo: nope/,
    )
  })
})
