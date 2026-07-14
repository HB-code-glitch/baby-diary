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
    for (const ageDays of [-1, 0, 29, 90, 179, 181, 365, 730]) {
      expect(getFeedingBand(ageDays)).toBeNull()
    }
  })
})

describe('evaluateFever object contract', () => {
  it('uses dates rather than a positional approximate age', () => {
    expect(evaluateFever({
      celsius: 38,
      birthdate: '2026-04-15',
      measuredAt: '2026-07-13T12:00:00+09:00',
    })).toBe('emergency')
  })

  it('does not turn temperature alone into a serious-diagnosis tier after six months', () => {
    expect(evaluateFever({
      celsius: 39.4,
      birthdate: '2026-01-01',
      measuredAt: '2026-07-13T12:00:00+09:00',
    })).toBe('warning')
  })
})

describe('FEVER_CARE structure', () => {
  it('keeps bilingual source-linked steps without retired home care', () => {
    expect(FEVER_CARE.steps.length).toBeGreaterThanOrEqual(3)
    expect(FEVER_CARE.sourceIds.length).toBeGreaterThan(0)
    for (const step of FEVER_CARE.steps) {
      expect(step.ko).toBeTruthy()
      expect(step.ja).toBeTruthy()
    }
    expect(JSON.stringify(FEVER_CARE)).not.toMatch(/미온|ぬるま湯|spong|NHS/i)
  })
})
