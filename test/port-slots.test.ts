import { describe, it, expect } from 'vitest'
import { firstFreeSlot, nextOverflowSlot } from '../src/core/ports.js'

describe('firstFreeSlot', () => {
  it('takes the lowest slot no worktree holds, reusing a freed one', () => {
    expect(firstFreeSlot(new Set(), 3)).toBe(1)
    expect(firstFreeSlot(new Set([1, 3]), 3)).toBe(2)
  })

  it('finds nothing once every slot is held', () => {
    expect(firstFreeSlot(new Set([1, 2]), 2)).toBeUndefined()
  })
})

describe('nextOverflowSlot', () => {
  it('shares slots in turn, wrapping back to the first', () => {
    expect([0, 1, 2].map((last) => nextOverflowSlot(last, 2))).toEqual([1, 2, 1])
  })

  it('starts again from slot 1 when the record is unusable', () => {
    expect(nextOverflowSlot(Number.NaN, 2)).toBe(1)
    expect(nextOverflowSlot(-1, 2)).toBe(1)
  })
})
