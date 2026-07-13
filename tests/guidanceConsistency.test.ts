import { describe, expect, it } from 'vitest'
import {
  FEEDING_BANDS,
  FEVER_CARE,
  evaluateFever,
  getFeedingBand,
} from '../src/lib/guidance'

describe('retired fixed-day formula compatibility', () => {
  it('does not return a quota band at any age', () => {
    expect(FEEDING_BANDS).toEqual([])
    for (const ageDays of [-1, 0, 29, 90, 181, 182, 365, 730]) {
      expect(getFeedingBand(ageDays)).toBeNull()
    }
  })
})

// Fever routing is replaced in Task 2. These assertions keep the existing UI
// callable while Task 1 retires only unsupported age/feeding compatibility.
describe('evaluateFever legacy callable shape', () => {
  it('routes under-90-day fever to the urgent level', () => {
    expect(evaluateFever(38, 89)).toBe('emergency')
  })

  it('keeps ordinary low temperatures below the modal threshold', () => {
    expect(evaluateFever(37.4, 100)).toBeNull()
    expect(evaluateFever(37.5, 100)).toBe('caution')
  })
})

describe('FEVER_CARE legacy structure', () => {
  it('keeps bilingual steps until Task 2 replaces them with structured safe care', () => {
    expect(FEVER_CARE.steps.length).toBeGreaterThan(0)
    for (const step of FEVER_CARE.steps) {
      expect(step.ko).toBeTruthy()
      expect(step.ja).toBeTruthy()
    }
  })
})
