/**
 * tests/guidanceConsistency.test.ts
 * Verifies FEEDING_BANDS numbers match the prose in guidance.ts markers,
 * and evaluateFever thresholds are correct.
 */
import { describe, it, expect } from 'vitest'
import {
  GUIDANCE_MARKERS,
  FEEDING_BANDS,
  getFeedingBand,
  evaluateFever,
  FEVER_CARE,
} from '../src/lib/guidance'

// ---------------------------------------------------------------------------
// FEEDING_BANDS consistency: each band's numbers must appear in marker bodyKo
// ---------------------------------------------------------------------------

describe('FEEDING_BANDS consistency with marker prose', () => {
  it('formula_0_1mo band numbers appear in marker bodyKo', () => {
    const marker = GUIDANCE_MARKERS.find(m => m.id === 'formula_0_1mo')!
    expect(marker).toBeDefined()
    const band = FEEDING_BANDS.find(b => b.id === 'formula_0_1mo')!
    expect(band).toBeDefined()
    // perFeedMlMin = 30 → "30" in prose
    expect(marker.bodyKo).toContain(String(band.perFeedMlMin))
    // perFeedMlMax = 120 → "120" in prose
    expect(marker.bodyKo).toContain(String(band.perFeedMlMax))
    // feedsPerDay 8-12 → "8~12" in prose
    expect(marker.bodyKo).toContain(`${band.feedsPerDayMin}~${band.feedsPerDayMax}`)
    // dailyMaxMl null
    expect(band.dailyMaxMl).toBeNull()
  })

  // P34: formula_1_3mo split into formula_1_2mo (30-59d, max 160) + formula_2_3mo (60-89d, max 180)
  it('formula_1_2mo band numbers appear in marker bodyKo', () => {
    const marker = GUIDANCE_MARKERS.find(m => m.id === 'formula_1_2mo')!
    const band = FEEDING_BANDS.find(b => b.id === 'formula_1_2mo')!
    expect(marker).toBeDefined()
    expect(band).toBeDefined()
    // perFeedMlMin=120, perFeedMlMax=160
    expect(marker.bodyKo).toContain('120')
    expect(marker.bodyKo).toContain('160')
    // feedsPerDay 6-7
    expect(marker.bodyKo).toContain(`${band.feedsPerDayMin}~${band.feedsPerDayMax}`)
    expect(band.dailyMaxMl).toBeNull()
  })

  it('formula_2_3mo band numbers appear in marker bodyKo', () => {
    const marker = GUIDANCE_MARKERS.find(m => m.id === 'formula_2_3mo')!
    const band = FEEDING_BANDS.find(b => b.id === 'formula_2_3mo')!
    expect(marker).toBeDefined()
    expect(band).toBeDefined()
    // perFeedMlMin=120, perFeedMlMax=180
    expect(marker.bodyKo).toContain('120')
    expect(marker.bodyKo).toContain('180')
    // feedsPerDay 6-7
    expect(marker.bodyKo).toContain(`${band.feedsPerDayMin}~${band.feedsPerDayMax}`)
    // perKgMlPerDay 150-165
    expect(marker.bodyKo).toContain('150')
    expect(marker.bodyKo).toContain('165')
    expect(band.dailyMaxMl).toBeNull()
  })

  it('formula_3_6mo band numbers appear in marker bodyKo', () => {
    const marker = GUIDANCE_MARKERS.find(m => m.id === 'formula_3_6mo')!
    const band = FEEDING_BANDS.find(b => b.id === 'formula_3_6mo')!
    expect(marker).toBeDefined()
    expect(band).toBeDefined()
    // perFeedMlMin=120, perFeedMlMax=240
    expect(marker.bodyKo).toContain('120')
    expect(marker.bodyKo).toContain('240')
    // feedsPerDay 4-5 → "4~5" in prose
    expect(marker.bodyKo).toContain(`${band.feedsPerDayMin}~${band.feedsPerDayMax}`)
    // dailyMaxMl=960 → "960" in prose
    expect(band.dailyMaxMl).toBe(960)
    expect(marker.bodyKo).toContain('960')
  })
})

// ---------------------------------------------------------------------------
// getFeedingBand — age routing
// ---------------------------------------------------------------------------

describe('getFeedingBand', () => {
  it('ageDays 0 → formula_0_1mo', () => {
    expect(getFeedingBand(0)?.id).toBe('formula_0_1mo')
  })
  it('ageDays 29 → formula_0_1mo', () => {
    expect(getFeedingBand(29)?.id).toBe('formula_0_1mo')
  })
  // P34: formula_1_3mo → formula_1_2mo (30-59d) + formula_2_3mo (60-89d)
  it('ageDays 30 → formula_1_2mo', () => {
    expect(getFeedingBand(30)?.id).toBe('formula_1_2mo')
  })
  it('ageDays 59 → formula_1_2mo', () => {
    expect(getFeedingBand(59)?.id).toBe('formula_1_2mo')
  })
  it('ageDays 60 → formula_2_3mo', () => {
    expect(getFeedingBand(60)?.id).toBe('formula_2_3mo')
  })
  it('ageDays 89 → formula_2_3mo', () => {
    expect(getFeedingBand(89)?.id).toBe('formula_2_3mo')
  })
  it('ageDays 90 → formula_3_6mo', () => {
    expect(getFeedingBand(90)?.id).toBe('formula_3_6mo')
  })
  it('ageDays 179 → formula_3_6mo', () => {
    expect(getFeedingBand(179)?.id).toBe('formula_3_6mo')
  })
  it('ageDays 180 → null (outside the source age window)', () => {
    expect(getFeedingBand(180)).toBeNull()
  })
  it('ageDays -1 → null', () => {
    expect(getFeedingBand(-1)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// evaluateFever — threshold logic
// ---------------------------------------------------------------------------

describe('evaluateFever', () => {
  it('prioritizes the under-90-day rule at 38.0°C', () => {
    expect(evaluateFever({
      celsius: 38,
      birthdate: '2026-04-15',
      measuredAt: '2026-07-13T12:00:00+09:00',
    })).toBe('emergency')
  })

  it('uses 38.3°C and 39.0°C thresholds from three to six completed months', () => {
    const age = { birthdate: '2026-01-31', measuredAt: '2026-05-01T12:00:00+09:00' }
    expect(evaluateFever({ ...age, celsius: 38 })).toBe('caution')
    expect(evaluateFever({ ...age, celsius: 38.3 })).toBe('warning')
    expect(evaluateFever({ ...age, celsius: 39 })).toBe('danger')
  })

  it('does not use temperature alone as a danger tier from six months', () => {
    expect(evaluateFever({
      celsius: 40,
      birthdate: '2026-01-31',
      measuredAt: '2026-07-31T12:00:00+09:00',
    })).toBe('caution')
  })

  it('returns null below 38.0°C when no urgent newborn or symptom rule applies', () => {
    expect(evaluateFever({
      celsius: 37.9,
      birthdate: '2026-01-31',
      measuredAt: '2026-07-31T12:00:00+09:00',
    })).toBeNull()
    expect(evaluateFever({ celsius: 37.9, birthdate: null })).toBeNull()
  })

  it('uses immediate contact for unknown age at 38.0°C or above', () => {
    expect(evaluateFever({ celsius: 38, birthdate: null })).toBe('emergency')
    expect(evaluateFever({ celsius: 39, birthdate: null })).toBe('emergency')
  })
})

// ---------------------------------------------------------------------------
// FEVER_CARE structure
// ---------------------------------------------------------------------------

describe('FEVER_CARE', () => {
  it('has concise home-care steps', () => {
    expect(FEVER_CARE.steps.length).toBeGreaterThanOrEqual(3)
  })
  it('every step has ko and ja text', () => {
    for (const step of FEVER_CARE.steps) {
      expect(step.ko).toBeTruthy()
      expect(step.ja).toBeTruthy()
    }
  })
  it('has a non-empty source label and no sponging instruction', () => {
    expect(FEVER_CARE.sourceLabel).toBeTruthy()
    expect(JSON.stringify(FEVER_CARE)).not.toMatch(/미온|ぬるま湯|spong/i)
  })
})
