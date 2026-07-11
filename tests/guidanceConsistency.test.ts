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
  it('ageDays 180 → formula_3_6mo', () => {
    expect(getFeedingBand(180)?.id).toBe('formula_3_6mo')
  })
  // P33: no upper cutoff — 181+ still returns formula_3_6mo
  it('ageDays 181 → formula_3_6mo (P33: no upper cutoff)', () => {
    expect(getFeedingBand(181)?.id).toBe('formula_3_6mo')
  })
  it('ageDays -1 → null', () => {
    expect(getFeedingBand(-1)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Feeding remaining calc (spec example: band 3-6mo, today 620 → 340 left)
// ---------------------------------------------------------------------------

describe('feeding remaining calc via FEEDING_BANDS', () => {
  it('3-6mo band dailyMaxMl=960, todayTotal=620 → remaining=340', () => {
    const band = FEEDING_BANDS.find(b => b.id === 'formula_3_6mo')!
    expect(band.dailyMaxMl).toBe(960)
    const remaining = band.dailyMaxMl! - 620
    expect(remaining).toBe(340)
  })

  it('3-6mo band dailyMaxMl=960, todayTotal=970 → remaining negative (reached)', () => {
    const band = FEEDING_BANDS.find(b => b.id === 'formula_3_6mo')!
    const remaining = band.dailyMaxMl! - 970
    expect(remaining).toBeLessThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// evaluateFever — threshold logic
// ---------------------------------------------------------------------------

describe('evaluateFever', () => {
  // emergency: ageDays < 90 && temp >= 38.0
  it('ageDays=89, temp=38.0 → emergency', () => {
    expect(evaluateFever(38.0, 89)).toBe('emergency')
  })
  it('ageDays=0, temp=38.5 → emergency', () => {
    expect(evaluateFever(38.5, 0)).toBe('emergency')
  })

  // ageDays=90 is NOT emergency — must fall into warning (38.0 but not >=39.0)
  it('ageDays=90, temp=38.0 → warning', () => {
    expect(evaluateFever(38.0, 90)).toBe('warning')
  })

  // danger: temp >= 39.0 (any age including >=90)
  it('ageDays=120, temp=39.0 → danger', () => {
    expect(evaluateFever(39.0, 120)).toBe('danger')
  })
  it('ageDays=89, temp=39.0 → emergency (under-90 takes priority)', () => {
    expect(evaluateFever(39.0, 89)).toBe('emergency')
  })

  // warning: temp >= 38.0 (age >= 90)
  it('ageDays=100, temp=38.5 → warning', () => {
    expect(evaluateFever(38.5, 100)).toBe('warning')
  })

  // caution: temp >= 37.5
  it('ageDays=100, temp=37.5 → caution', () => {
    expect(evaluateFever(37.5, 100)).toBe('caution')
  })
  it('ageDays=100, temp=37.9 → caution', () => {
    expect(evaluateFever(37.9, 100)).toBe('caution')
  })

  // null: below 37.5
  it('ageDays=100, temp=37.4 → null', () => {
    expect(evaluateFever(37.4, 100)).toBeNull()
  })
  it('ageDays=100, temp=36.5 → null', () => {
    expect(evaluateFever(36.5, 100)).toBeNull()
  })

  // ageDays=null (birthdate unknown): no emergency tier
  it('ageDays=null, temp=38.0 → warning (no emergency without age)', () => {
    expect(evaluateFever(38.0, null)).toBe('warning')
  })
  it('ageDays=null, temp=39.0 → danger', () => {
    expect(evaluateFever(39.0, null)).toBe('danger')
  })
  it('ageDays=null, temp=37.5 → caution', () => {
    expect(evaluateFever(37.5, null)).toBe('caution')
  })
  it('ageDays=null, temp=37.4 → null', () => {
    expect(evaluateFever(37.4, null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FEVER_CARE structure
// ---------------------------------------------------------------------------

describe('FEVER_CARE', () => {
  it('has at least 4 steps', () => {
    expect(FEVER_CARE.steps.length).toBeGreaterThanOrEqual(4)
  })
  it('every step has ko and ja text', () => {
    for (const step of FEVER_CARE.steps) {
      expect(step.ko).toBeTruthy()
      expect(step.ja).toBeTruthy()
    }
  })
  it('sourceLabel contains AAP', () => {
    expect(FEVER_CARE.sourceLabel).toContain('AAP')
  })
})
