import { describe, expect, it } from 'vitest'
import { nextHybridLogicalClock } from '../shared/hybridLogicalClock'

describe('hybrid logical clock', () => {
  it('promotes a legacy counter to epoch milliseconds', () => {
    expect(nextHybridLogicalClock(7, 1_752_400_000_000)).toBe(1_752_400_000_000)
  })

  it('advances a clock that is already ahead without moving backwards', () => {
    expect(nextHybridLogicalClock(1_752_400_000_123, 1_752_400_000_000))
      .toBe(1_752_400_000_124)
  })

  it('fails closed for unsafe, negative, and exhausted clocks', () => {
    expect(() => nextHybridLogicalClock(-1, 1)).toThrow(/prior/)
    expect(() => nextHybridLogicalClock(0, Number.NaN)).toThrow(/current/)
    expect(() => nextHybridLogicalClock(Number.MAX_SAFE_INTEGER, 1)).toThrow(/exhausted/)
  })
})
