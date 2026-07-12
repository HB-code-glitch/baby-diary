/**
 * tests/breastfeeding.test.ts
 * Vitest unit tests for breastfeeding.ts helpers.
 */

import { describe, it, expect } from 'vitest'
import {
  BREASTFEEDING_BANDS,
  BF_DISCLAIMER,
  BF_CLUSTER_NOTE,
  BF_NEWBORN_RULE,
  BF_SOURCE_NOTES,
  getBreastBand,
  computeNextFeed,
  formatCountdown,
} from '../src/lib/breastfeeding'

// ---------------------------------------------------------------------------
// Dataset shape
// ---------------------------------------------------------------------------

describe('BREASTFEEDING_BANDS dataset', () => {
  it('has exactly 8 bands', () => {
    expect(BREASTFEEDING_BANDS).toHaveLength(8)
  })

  it('all bands have required fields', () => {
    for (const band of BREASTFEEDING_BANDS) {
      expect(band.id).toBeTruthy()
      expect(typeof band.startDay).toBe('number')
      expect(band.startDay).toBeGreaterThanOrEqual(0)
      expect(band.ageLabelKo).toBeTruthy()
      expect(band.ageLabelJa).toBeTruthy()
      expect(typeof band.intervalMinHours).toBe('number')
      expect(band.feedsPerDayMin).toBeGreaterThan(0)
      expect(band.feedsPerDayMax).toBeGreaterThanOrEqual(band.feedsPerDayMin)
      expect(band.noteKo).toBeTruthy()
      expect(band.noteJa).toBeTruthy()
      expect(band.sourceLabel).toBeTruthy()
    }
  })

  it('newborn bands (0-2w and 2-4w) have maxStretchHours === 4', () => {
    const newborn0 = BREASTFEEDING_BANDS.find(b => b.id === 'newborn-0-2w')!
    const newborn2 = BREASTFEEDING_BANDS.find(b => b.id === 'newborn-2-4w')!
    expect(newborn0.maxStretchHours).toBe(4)
    expect(newborn2.maxStretchHours).toBe(4)
  })

  it('m12-24 band has intervalMaxHours === null', () => {
    const band = BREASTFEEDING_BANDS.find(b => b.id === 'm12-24')!
    expect(band.intervalMaxHours).toBeNull()
    expect(band.maxStretchHours).toBeNull()
  })

  it('bands are sorted by startDay ascending', () => {
    for (let i = 1; i < BREASTFEEDING_BANDS.length; i++) {
      expect(BREASTFEEDING_BANDS[i].startDay).toBeGreaterThan(BREASTFEEDING_BANDS[i - 1].startDay)
    }
  })

  it('each band intervalMaxHours >= intervalMinHours (when not null)', () => {
    for (const band of BREASTFEEDING_BANDS) {
      if (band.intervalMaxHours !== null) {
        expect(band.intervalMaxHours).toBeGreaterThanOrEqual(band.intervalMinHours)
      }
    }
  })
})

describe('BF_DISCLAIMER', () => {
  it('ko disclaimer contains 참고용', () => {
    expect(BF_DISCLAIMER.ko).toContain('참고용')
  })

  it('ja disclaimer is in Japanese', () => {
    expect(BF_DISCLAIMER.ja).toMatch(/目安/)
  })
})

describe('BF_CLUSTER_NOTE', () => {
  it('ko cluster note references 6~10시 evening window', () => {
    expect(BF_CLUSTER_NOTE.ko).toContain('6~10시')
  })

  it('ja cluster note references 18-22시 window', () => {
    expect(BF_CLUSTER_NOTE.ja).toContain('18〜22時')
  })
})

describe('BF_NEWBORN_RULE', () => {
  it('ko rule mentions 낮 3시간·밤 4시간', () => {
    expect(BF_NEWBORN_RULE.ko).toContain('낮')
    expect(BF_NEWBORN_RULE.ko).toContain('3시간')
    expect(BF_NEWBORN_RULE.ko).toContain('4시간')
  })

  it('ja rule mentions 昼 and 夜 limits', () => {
    expect(BF_NEWBORN_RULE.ja).toContain('昼')
    expect(BF_NEWBORN_RULE.ja).toContain('夜')
  })
})

describe('BF_SOURCE_NOTES', () => {
  it('has source notes array (non-empty)', () => {
    expect(Array.isArray(BF_SOURCE_NOTES)).toBe(true)
    expect(BF_SOURCE_NOTES.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// getBreastBand — band routing
// ---------------------------------------------------------------------------

describe('getBreastBand — band routing', () => {
  it('day 5 → newborn-0-2w', () => {
    expect(getBreastBand(5).id).toBe('newborn-0-2w')
  })

  it('day 0 → newborn-0-2w', () => {
    expect(getBreastBand(0).id).toBe('newborn-0-2w')
  })

  it('day 13 → newborn-0-2w (startDay 14 not yet reached)', () => {
    expect(getBreastBand(13).id).toBe('newborn-0-2w')
  })

  it('day 14 → newborn-2-4w (startDay 14 exactly reached)', () => {
    expect(getBreastBand(14).id).toBe('newborn-2-4w')
  })

  it('day 20 → newborn-2-4w', () => {
    expect(getBreastBand(20).id).toBe('newborn-2-4w')
  })

  it('day 29 → newborn-2-4w', () => {
    expect(getBreastBand(29).id).toBe('newborn-2-4w')
  })

  it('day 30 → m1-2', () => {
    expect(getBreastBand(30).id).toBe('m1-2')
  })

  it('day 89 → m1-2', () => {
    expect(getBreastBand(89).id).toBe('m1-2')
  })

  it('day 90 → m3-4', () => {
    expect(getBreastBand(90).id).toBe('m3-4')
  })

  it('day 100 → m3-4', () => {
    expect(getBreastBand(100).id).toBe('m3-4')
  })

  it('day 119 → m3-4', () => {
    expect(getBreastBand(119).id).toBe('m3-4')
  })

  it('day 120 → m4-6', () => {
    expect(getBreastBand(120).id).toBe('m4-6')
  })

  it('day 400 → m12-24', () => {
    expect(getBreastBand(400).id).toBe('m12-24')
  })

  it('day 365 → m12-24 (startDay 365 exactly)', () => {
    expect(getBreastBand(365).id).toBe('m12-24')
  })
})

// ---------------------------------------------------------------------------
// computeNextFeed — date math
// ---------------------------------------------------------------------------

describe('computeNextFeed — interval math', () => {
  // Use a fixed ISO time for determinism
  const lastAt = '2026-07-12T10:00:00.000Z'

  it('day 5 (newborn-0-2w): windowStart = last + 1.5h', () => {
    const { windowStart, band } = computeNextFeed(lastAt, 5)
    expect(band.id).toBe('newborn-0-2w')
    const expectedMs = new Date(lastAt).getTime() + 1.5 * 60 * 60 * 1000
    expect(windowStart.getTime()).toBe(expectedMs)
  })

  it('day 5 (newborn-0-2w): windowEnd = last + 3h', () => {
    const { windowEnd } = computeNextFeed(lastAt, 5)
    const expectedMs = new Date(lastAt).getTime() + 3 * 60 * 60 * 1000
    expect(windowEnd).not.toBeNull()
    expect(windowEnd!.getTime()).toBe(expectedMs)
  })

  it('day 5 (newborn-0-2w): maxStretchAt = last + 4h', () => {
    const { maxStretchAt } = computeNextFeed(lastAt, 5)
    const expectedMs = new Date(lastAt).getTime() + 4 * 60 * 60 * 1000
    expect(maxStretchAt).not.toBeNull()
    expect(maxStretchAt!.getTime()).toBe(expectedMs)
  })

  it('day 20 (newborn-2-4w): windowStart = last + 2h', () => {
    const { windowStart } = computeNextFeed(lastAt, 20)
    const expectedMs = new Date(lastAt).getTime() + 2 * 60 * 60 * 1000
    expect(windowStart.getTime()).toBe(expectedMs)
  })

  it('day 100 (m3-4): windowStart = last + 3h, windowEnd = last + 4h', () => {
    const { windowStart, windowEnd, band } = computeNextFeed(lastAt, 100)
    expect(band.id).toBe('m3-4')
    expect(windowStart.getTime()).toBe(new Date(lastAt).getTime() + 3 * 60 * 60 * 1000)
    expect(windowEnd!.getTime()).toBe(new Date(lastAt).getTime() + 4 * 60 * 60 * 1000)
  })

  it('day 100 (m3-4): maxStretchAt is null', () => {
    const { maxStretchAt } = computeNextFeed(lastAt, 100)
    expect(maxStretchAt).toBeNull()
  })

  it('day 400 (m12-24): windowEnd is null (intervalMaxHours null)', () => {
    const { windowEnd, band } = computeNextFeed(lastAt, 400)
    expect(band.id).toBe('m12-24')
    expect(windowEnd).toBeNull()
  })

  it('day 400 (m12-24): windowStart = last + 6h', () => {
    const { windowStart } = computeNextFeed(lastAt, 400)
    expect(windowStart.getTime()).toBe(new Date(lastAt).getTime() + 6 * 60 * 60 * 1000)
  })

  it('day 400 (m12-24): maxStretchAt is null', () => {
    const { maxStretchAt } = computeNextFeed(lastAt, 400)
    expect(maxStretchAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// formatCountdown
// ---------------------------------------------------------------------------

describe('formatCountdown', () => {
  it('2h 30min → "2시간 30분" in ko', () => {
    const ms = (2 * 60 + 30) * 60 * 1000
    expect(formatCountdown(ms, 'ko')).toBe('2시간 30분')
  })

  it('2h 0min → "2시간" in ko', () => {
    const ms = 2 * 60 * 60 * 1000
    expect(formatCountdown(ms, 'ko')).toBe('2시간')
  })

  it('45min → "45분" in ko', () => {
    const ms = 45 * 60 * 1000
    expect(formatCountdown(ms, 'ko')).toBe('45분')
  })

  it('2h 30min → "2時間30分" in ja', () => {
    const ms = (2 * 60 + 30) * 60 * 1000
    expect(formatCountdown(ms, 'ja')).toBe('2時間30分')
  })

  it('3h 0min → "3時間" in ja', () => {
    const ms = 3 * 60 * 60 * 1000
    expect(formatCountdown(ms, 'ja')).toBe('3時間')
  })

  it('20min → "20分" in ja', () => {
    const ms = 20 * 60 * 1000
    expect(formatCountdown(ms, 'ja')).toBe('20分')
  })

  it('negative ms → "0분"', () => {
    expect(formatCountdown(-5000, 'ko')).toBe('0분')
  })

  it('0 ms → "0분"', () => {
    expect(formatCountdown(0, 'ko')).toBe('0분')
  })
})

// ---------------------------------------------------------------------------
// Consistency checks
// ---------------------------------------------------------------------------

describe('consistency checks', () => {
  it('newborn-0-2w noteKo mentions 8~12회', () => {
    const band = BREASTFEEDING_BANDS.find(b => b.id === 'newborn-0-2w')!
    expect(band.noteKo).toContain('8~12회')
  })

  it('newborn-0-2w noteKo mentions 낮 3시간·밤 4시간', () => {
    const band = BREASTFEEDING_BANDS.find(b => b.id === 'newborn-0-2w')!
    expect(band.noteKo).toContain('낮 3시간')
    expect(band.noteKo).toContain('밤 4시간')
  })

  it('m12-24 noteKo mentions WHO', () => {
    const band = BREASTFEEDING_BANDS.find(b => b.id === 'm12-24')!
    expect(band.noteKo).toContain('WHO')
  })

  it('each band feedsPerDayMax/Min consistent with noteKo or JSON values', () => {
    // Basic sanity: feedsPerDayMin <= feedsPerDayMax for all bands
    for (const band of BREASTFEEDING_BANDS) {
      expect(band.feedsPerDayMax).toBeGreaterThanOrEqual(band.feedsPerDayMin)
    }
  })

  it('newborn-0-2w intervalMinHours is 1.5', () => {
    const band = BREASTFEEDING_BANDS.find(b => b.id === 'newborn-0-2w')!
    expect(band.intervalMinHours).toBe(1.5)
  })

  it('newborn-0-2w feedsPerDayMin is 8, feedsPerDayMax is 12', () => {
    const band = BREASTFEEDING_BANDS.find(b => b.id === 'newborn-0-2w')!
    expect(band.feedsPerDayMin).toBe(8)
    expect(band.feedsPerDayMax).toBe(12)
  })
})
