import { describe, it, expect } from 'vitest'
import { computeZ, zToPercentile, percentileBandValue } from '../src/lib/whoGrowth'

describe('computeZ', () => {
  // Known value: boy 12mo weight 9.6479kg -> z ~ 0 (median = M at 12mo for WFA_BOYS)
  it('boy 12mo weight=9.6479kg -> z~0 (P50)', () => {
    const z = computeZ('weight', 'boy', 12, 9.6479)
    expect(Math.abs(z)).toBeLessThan(0.01)
  })

  // Known value: girl 0mo height 49.1477cm -> P50 (LHFA_GIRLS month 0 M=49.1477)
  it('girl 0mo height=49.1477cm -> z~0 (P50)', () => {
    const z = computeZ('height', 'girl', 0, 49.1477)
    expect(Math.abs(z)).toBeLessThan(0.01)
  })

  // Interpolation midpoint: between month 0 and 1 for boys weight
  // WFA_BOYS: mo0 M=3.3464, mo1 M=4.4709 -> midpoint M ~ 3.9087
  it('boy 0.5mo weight interpolation midpoint', () => {
    const z = computeZ('weight', 'boy', 0.5, 3.9087)
    expect(Math.abs(z)).toBeLessThan(0.05)
  })

  // |z|>3 weight SD23 adjustment for boy: very low weight
  it('boy 12mo weight=5.0kg -> |z|>3 (adjusted)', () => {
    const z = computeZ('weight', 'boy', 12, 5.0)
    // Should be well below -3
    expect(z).toBeLessThan(-3)
    // Should be finite (not NaN or -Infinity)
    expect(isFinite(z)).toBe(true)
  })

  // |z|>3 positive side
  it('boy 12mo weight=16.0kg -> |z|>3 positive (adjusted)', () => {
    const z = computeZ('weight', 'boy', 12, 16.0)
    expect(z).toBeGreaterThan(3)
    expect(isFinite(z)).toBe(true)
  })
})

describe('zToPercentile', () => {
  it('z=0 -> P50', () => {
    expect(Math.abs(zToPercentile(0) - 50)).toBeLessThan(0.1)
  })

  it('z=-1.645 -> P5 (approx)', () => {
    expect(Math.abs(zToPercentile(-1.645) - 5)).toBeLessThan(0.5)
  })

  it('z=1.282 -> P90 (approx)', () => {
    expect(Math.abs(zToPercentile(1.282) - 90)).toBeLessThan(0.5)
  })

  it('erf approximation accuracy: z=1 -> P84.13 +-0.1', () => {
    expect(Math.abs(zToPercentile(1) - 84.13)).toBeLessThan(0.1)
  })
})

describe('percentileBandValue', () => {
  it('returns M at z=0 for boy 12mo weight', () => {
    const val = percentileBandValue('weight', 'boy', 12, 0)
    expect(Math.abs(val - 9.6479)).toBeLessThan(0.01)
  })

  it('z=2 value > z=0 value', () => {
    const m = percentileBandValue('weight', 'boy', 12, 0)
    const p2 = percentileBandValue('weight', 'boy', 12, 2)
    expect(p2).toBeGreaterThan(m)
  })

  it('interpolates between months correctly', () => {
    const v05 = percentileBandValue('weight', 'boy', 0.5, 0)
    const v0 = percentileBandValue('weight', 'boy', 0, 0)
    const v1 = percentileBandValue('weight', 'boy', 1, 0)
    // Midpoint should be between the two endpoints
    expect(v05).toBeGreaterThan(v0)
    expect(v05).toBeLessThan(v1)
  })
})
