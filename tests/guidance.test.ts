/**
 * tests/guidance.test.ts
 * Vitest unit tests for getGuidanceForAge() and getCalendarGuidance().
 */

import { describe, it, expect } from 'vitest'
import {
  getGuidanceForAge,
  getCalendarGuidance,
  GUIDANCE_MARKERS,
  GUIDANCE_DISCLAIMER,
  GUIDANCE_SOURCES,
} from '../src/lib/guidance'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns age-in-days offset date string relative to a birth date */
function ageDayStr(birthdate: string, ageInDays: number): string {
  const birth = new Date(birthdate)
  const d = new Date(birth.getTime() + ageInDays * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Dataset shape checks
// ---------------------------------------------------------------------------

describe('GUIDANCE_MARKERS dataset', () => {
  it('has exactly 14 markers (P34: formula_1_3mo split into 2)', () => {
    expect(GUIDANCE_MARKERS).toHaveLength(14)
  })

  it('all markers have required fields', () => {
    for (const m of GUIDANCE_MARKERS) {
      expect(m.id).toBeTruthy()
      expect(typeof m.startDay).toBe('number')
      expect(m.startDay).toBeGreaterThanOrEqual(0)
      expect(m.titleKo).toBeTruthy()
      expect(m.titleJa).toBeTruthy()
      expect(m.bodyKo).toBeTruthy()
      expect(m.bodyJa).toBeTruthy()
      expect(m.sourceLabel).toBeTruthy()
      expect(['guideline-consensus', 'RCT']).toContain(m.evidenceLevel)
    }
  })

  it('contains the 5 calendar markers (startDay > 0; P34 split)', () => {
    // P34: formula_1_3mo split into formula_1_2mo + formula_2_3mo → now 5 cal markers
    const calMarkers = GUIDANCE_MARKERS.filter(m => m.startDay > 0)
    const ids = calMarkers.map(m => m.id)
    expect(ids).toContain('formula_1_2mo')
    expect(ids).toContain('formula_2_3mo')
    expect(ids).toContain('formula_3_6mo')
    expect(ids).toContain('weaning_start_readiness')
    expect(ids).toContain('allergen_early_intro')
  })

  it('day-0 markers: all 9 have startDay===0', () => {
    const day0 = GUIDANCE_MARKERS.filter(m => m.startDay === 0)
    expect(day0).toHaveLength(9)
  })
})

describe('GUIDANCE_DISCLAIMER', () => {
  it('ko disclaimer is in Korean', () => {
    expect(GUIDANCE_DISCLAIMER.ko).toMatch(/소아과/)
  })

  it('ja disclaimer is in Japanese', () => {
    expect(GUIDANCE_DISCLAIMER.ja).toMatch(/小児科/)
  })
})

describe('GUIDANCE_SOURCES', () => {
  it('has sources with org/title/year/url', () => {
    expect(GUIDANCE_SOURCES.length).toBeGreaterThan(0)
    for (const s of GUIDANCE_SOURCES) {
      expect(s.org).toBeTruthy()
      expect(s.title).toBeTruthy()
      expect(s.year).toBeTruthy()
      expect(s.url).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// getGuidanceForAge — age band selection
// ---------------------------------------------------------------------------

describe('getGuidanceForAge — formula band selection', () => {
  const birth = '2026-01-01'

  it('day 10 → formula_0_1mo', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 10))
    const formula = markers.find(m => m.id.startsWith('formula_'))
    expect(formula?.id).toBe('formula_0_1mo')
  })

  it('day 45 → formula_1_2mo (startDay 30 is highest <= 45; P34)', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 45))
    const formula = markers.find(m => m.id.startsWith('formula_'))
    expect(formula?.id).toBe('formula_1_2mo')
  })

  it('day 100 → formula_3_6mo (startDay 90 is highest <= 100)', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 100))
    const formula = markers.find(m => m.id.startsWith('formula_'))
    expect(formula?.id).toBe('formula_3_6mo')
  })

  it('day 0 → formula_0_1mo', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 0))
    const formula = markers.find(m => m.id.startsWith('formula_'))
    expect(formula?.id).toBe('formula_0_1mo')
  })

  it('day 29 → formula_0_1mo (startDay 30 not yet reached)', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 29))
    const formula = markers.find(m => m.id.startsWith('formula_'))
    expect(formula?.id).toBe('formula_0_1mo')
  })

  it('day 30 → formula_1_2mo (startDay 30 exactly reached; P34)', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 30))
    const formula = markers.find(m => m.id.startsWith('formula_'))
    expect(formula?.id).toBe('formula_1_2mo')
  })

  it('day 90 → formula_3_6mo (startDay 90 exactly reached)', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 90))
    const formula = markers.find(m => m.id.startsWith('formula_'))
    expect(formula?.id).toBe('formula_3_6mo')
  })

  it('returns only one formula marker', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 45))
    const formulaMarkers = markers.filter(m => m.id.startsWith('formula_'))
    expect(formulaMarkers).toHaveLength(1)
  })
})

describe('getGuidanceForAge — weaning and allergen markers', () => {
  const birth = '2026-01-01'

  it('day 119 → no weaning/allergen markers yet (startDay 120 not reached)', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 119))
    expect(markers.find(m => m.id === 'weaning_start_readiness')).toBeUndefined()
    expect(markers.find(m => m.id === 'allergen_early_intro')).toBeUndefined()
  })

  it('day 120 → weaning_start_readiness and allergen_early_intro both active', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 120))
    expect(markers.find(m => m.id === 'weaning_start_readiness')).toBeDefined()
    expect(markers.find(m => m.id === 'allergen_early_intro')).toBeDefined()
  })

  it('day 200 → weaning and allergen still active', () => {
    const markers = getGuidanceForAge(birth, ageDayStr(birth, 200))
    expect(markers.find(m => m.id === 'weaning_start_readiness')).toBeDefined()
    expect(markers.find(m => m.id === 'allergen_early_intro')).toBeDefined()
  })
})

describe('getGuidanceForAge — edge cases', () => {
  it('empty birthdate → empty result', () => {
    expect(getGuidanceForAge('')).toEqual([])
  })

  it('negative age (future birth) → empty result', () => {
    const futureDate = '2099-01-01'
    expect(getGuidanceForAge(futureDate, '2026-07-11')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getCalendarGuidance — date mapping
// ---------------------------------------------------------------------------

describe('getCalendarGuidance', () => {
  it('birth 2026-01-01 → weaning_start_readiness on 2026-05-01 (day 120)', () => {
    const items = getCalendarGuidance('2026-01-01')
    const weaning = items.find(i => i.marker.id === 'weaning_start_readiness')
    expect(weaning).toBeDefined()
    expect(weaning?.date).toBe('2026-05-01')
  })

  it('birth 2026-01-01 → allergen_early_intro on 2026-05-01 (day 120)', () => {
    const items = getCalendarGuidance('2026-01-01')
    const allergen = items.find(i => i.marker.id === 'allergen_early_intro')
    expect(allergen).toBeDefined()
    expect(allergen?.date).toBe('2026-05-01')
  })

  it('birth 2026-01-01 → formula_1_2mo on 2026-01-31 (day 30; P34)', () => {
    const items = getCalendarGuidance('2026-01-01')
    const f = items.find(i => i.marker.id === 'formula_1_2mo')
    expect(f).toBeDefined()
    expect(f?.date).toBe('2026-01-31')
  })

  it('birth 2026-01-01 → formula_2_3mo on 2026-03-02 (day 60; P34)', () => {
    const items = getCalendarGuidance('2026-01-01')
    const f = items.find(i => i.marker.id === 'formula_2_3mo')
    expect(f).toBeDefined()
    // Jan 1 + 60 days = March 2
    expect(f?.date).toBe('2026-03-02')
  })

  it('birth 2026-01-01 → formula_3_6mo on 2026-04-01 (day 90)', () => {
    const items = getCalendarGuidance('2026-01-01')
    const f = items.find(i => i.marker.id === 'formula_3_6mo')
    expect(f).toBeDefined()
    expect(f?.date).toBe('2026-04-01')
  })

  it('day-0 markers excluded from calendar list', () => {
    const items = getCalendarGuidance('2026-01-01')
    const day0Items = items.filter(i => i.marker.startDay === 0)
    expect(day0Items).toHaveLength(0)
  })

  it('returns exactly 5 items (the 5 startDay>0 markers after P34 split)', () => {
    // P34: formula_1_3mo split into formula_1_2mo (startDay 30) + formula_2_3mo (startDay 60)
    // Total startDay>0: formula_1_2mo, formula_2_3mo, formula_3_6mo, weaning_start_readiness, allergen_early_intro = 5
    const items = getCalendarGuidance('2026-01-01')
    expect(items).toHaveLength(5)
  })

  it('empty birthdate → empty result', () => {
    expect(getCalendarGuidance('')).toEqual([])
  })

  it('all returned dates are valid yyyy-MM-dd', () => {
    const items = getCalendarGuidance('2026-06-15')
    for (const item of items) {
      expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

// ---------------------------------------------------------------------------
// fever marker quote fields — must not truncate at decimal points
// ---------------------------------------------------------------------------

describe('fever marker quoteKo/quoteJa fields', () => {
  it('fever_under_3mo_emergency has non-empty quoteKo containing 38.0', () => {
    const m = GUIDANCE_MARKERS.find(m => m.id === 'fever_under_3mo_emergency')!
    expect(m.quoteKo).toBeTruthy()
    expect(m.quoteKo).toContain('38.0')
  })

  it('fever_under_3mo_emergency has non-empty quoteJa containing 38.0', () => {
    const m = GUIDANCE_MARKERS.find(m => m.id === 'fever_under_3mo_emergency')!
    expect(m.quoteJa).toBeTruthy()
    expect(m.quoteJa).toContain('38.0')
  })

  it('antipyretic_age_limits has non-empty quoteKo', () => {
    const m = GUIDANCE_MARKERS.find(m => m.id === 'antipyretic_age_limits')!
    expect(m.quoteKo).toBeTruthy()
  })

  it('antipyretic_age_limits has non-empty quoteJa', () => {
    const m = GUIDANCE_MARKERS.find(m => m.id === 'antipyretic_age_limits')!
    expect(m.quoteJa).toBeTruthy()
  })

  it('fever_under_3mo_emergency quoteKo is a complete first sentence (ends with 가요.)', () => {
    const m = GUIDANCE_MARKERS.find(m => m.id === 'fever_under_3mo_emergency')!
    expect(m.quoteKo).toMatch(/가요\.$/)
  })
})
