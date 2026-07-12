import { describe, it, expect } from 'vitest'
import { buildReportModel } from '../src/lib/reportModel'
import type { DiaryEvent, AppSettings } from '../shared/types'

// Fixed "now" constructed via local-time Date() so date-fns format/subDays
// produce consistent local-calendar dates in any runner timezone.
const NOW = new Date(2026, 2, 15, 12, 0)  // local 2026-03-15 12:00

const SETTINGS: AppSettings = {
  baby: { name: 'Hana', birthdate: '2025-09-15', gender: 'girl' },
  profile: { uid: 'u1', name: 'Mom', role: 'mom' },
  familyId: 'f1',
  firebase: null,
  language: 'ko',
}

function makeEvent(partial: Partial<DiaryEvent> & { type: DiaryEvent['type']; at: string; data: DiaryEvent['data'] }): DiaryEvent {
  return {
    id: Math.random().toString(36).slice(2),
    createdAt: partial.at,
    updatedAt: partial.at,
    rev: 1,
    deleted: false,
    author: { uid: 'u1', name: 'Mom', role: 'mom' },
    ...partial,
  }
}

// last-7-day events
// NOW = 2026-03-15
// last 7 days = 2026-03-09 .. 2026-03-15 (today inclusive)
// Helper: construct an ISO string from LOCAL calendar date+time so that
// date-fns isSameDay() (which uses local time) groups events correctly in
// any runner timezone. Use this for boundary-case timestamps.
function localISO(year: number, month0: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month0, day, hour, minute).toISOString()
}

const FORMULA_EVENTS: DiaryEvent[] = [
  // local day 2026-03-14: 3 feedings at 120ml each
  makeEvent({ type: 'formula', at: localISO(2026, 2, 14,  6,  0), data: { ml: 120 } }),
  makeEvent({ type: 'formula', at: localISO(2026, 2, 14, 10,  0), data: { ml: 120 } }),
  makeEvent({ type: 'formula', at: localISO(2026, 2, 14, 14,  0), data: { ml: 120 } }),
  // local day 2026-03-13: 2 feedings at 150ml each
  makeEvent({ type: 'formula', at: localISO(2026, 2, 13,  8,  0), data: { ml: 150 } }),
  // boundary-crossing event: local 2026-03-14T01:00 — still Mar 14 in local time
  // (was a fixed UTC instant that relied on UTC+9 to land on Mar 14; now timezone-agnostic)
  makeEvent({ type: 'formula', at: localISO(2026, 2, 14,  1,  0), data: { ml: 150 } }),
]
const BREAST_EVENTS: DiaryEvent[] = [
  makeEvent({ type: 'breast', at: localISO(2026, 2, 14,  8,  0), data: { side: 'L' } }),
]
const DIAPER_EVENTS: DiaryEvent[] = [
  makeEvent({ type: 'pee',  at: localISO(2026, 2, 14,  7,  0), data: {} }),
  makeEvent({ type: 'poop', at: localISO(2026, 2, 14,  9,  0), data: {} }),
  makeEvent({ type: 'pee',  at: localISO(2026, 2, 13,  7,  0), data: {} }),
]
const SLEEP_EVENTS: DiaryEvent[] = [
  makeEvent({ type: 'sleep', at: localISO(2026, 2, 14, 20,  0), data: { minutes: 480 } }),
  makeEvent({ type: 'sleep', at: localISO(2026, 2, 13, 20,  0), data: { minutes: 360 } }),
]
const TEMP_EVENTS: DiaryEvent[] = [
  makeEvent({ type: 'temp', at: localISO(2026, 2, 14,  8,  0), data: { celsius: 37.5 } }),
  makeEvent({ type: 'temp', at: localISO(2026, 2, 14, 20,  0), data: { celsius: 38.2 } }),
  makeEvent({ type: 'temp', at: localISO(2026, 2, 13,  8,  0), data: { celsius: 37.0 } }),
]
const GROWTH_EVENTS: DiaryEvent[] = [
  makeEvent({ type: 'growth', at: localISO(2026, 1, 15, 10,  0), data: { weightKg: 6.8, heightCm: 65.0 } }),
  makeEvent({ type: 'growth', at: localISO(2026, 2,  1, 10,  0), data: { weightKg: 7.2, heightCm: 66.5 } }),
]

const ALL_EVENTS: DiaryEvent[] = [
  ...FORMULA_EVENTS,
  ...BREAST_EVENTS,
  ...DIAPER_EVENTS,
  ...SLEEP_EVENTS,
  ...TEMP_EVENTS,
  ...GROWTH_EVENTS,
]

describe('buildReportModel', () => {
  it('returns baby info from settings', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    expect(model.babyName).toBe('Hana')
    expect(model.birthdate).toBe('2025-09-15')
    expect(model.ageMonths).toBe(6)  // Sep 15 -> Mar 15 = 6 months
  })

  it('last7.avgFeedingPerDay counts formula+breast', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    // 5 formula + 1 breast = 6 feedings in the events; distributed over 7 days
    // Only days with data: 2026-03-14 has 4 feedings, 2026-03-13 has 2 feedings
    // avg over 7 days = 6/7
    expect(model.last7.avgFeedingPerDay).toBeCloseTo(6 / 7, 2)
  })

  it('last7.avgFormulaMlPerDay sums only formula ml', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    // 3*120 + 2*150 = 360+300 = 660ml across 7 days -> 660/7
    expect(model.last7.avgFormulaMlPerDay).toBeCloseTo(660 / 7, 1)
  })

  it('last7.avgDiaperPerDay counts pee+poop', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    // 1 pee + 1 poop on 2026-03-14; 1 pee on 2026-03-13 = 3 total / 7 days
    expect(model.last7.avgDiaperPerDay).toBeCloseTo(3 / 7, 2)
  })

  it('last7.avgSleepHoursPerDay converts minutes correctly', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    // 480+360 = 840 minutes = 14 hours / 7 = 2.0 h/day
    expect(model.last7.avgSleepHoursPerDay).toBeCloseTo(14 / 7, 2)
  })

  it('last7.recentTemp is the latest temp reading', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    // Latest temp event by `at` within last 7 days
    // 2026-03-14T20:00 = 38.2
    expect(model.last7.recentTemp).toBeCloseTo(38.2, 1)
  })

  it('last7.maxTemp is the highest temp', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    expect(model.last7.maxTemp).toBeCloseTo(38.2, 1)
  })

  it('last7.feverCount counts readings >= 38.0', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    // 38.2 on 2026-03-14T20 -- only one reading >= 38
    expect(model.last7.feverCount).toBe(1)
  })

  it('last30 aggregates over 30 days including last 7', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    // Same events but divided by 30 days
    expect(model.last30.avgFeedingPerDay).toBeCloseTo(6 / 30, 2)
  })

  it('growthRows contains all growth events newest-first', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    expect(model.growthRows).toHaveLength(2)
    expect(model.growthRows[0].weightKg).toBe(7.2) // newest first
    expect(model.growthRows[1].weightKg).toBe(6.8)
  })

  it('growthRows include WHO percentiles when weight/height present', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    const row = model.growthRows[0]
    expect(row.weightPct).toBeGreaterThan(0)
    expect(row.weightPct).toBeLessThan(100)
    expect(row.heightPct).toBeGreaterThan(0)
    expect(row.heightPct).toBeLessThan(100)
  })

  it('last7DayRows has 7 entries newest-first', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    expect(model.last7DayRows).toHaveLength(7)
    // first row = 2026-03-15 (today = NOW), last row = 2026-03-09
    expect(model.last7DayRows[0].date).toBe('2026-03-15')
    expect(model.last7DayRows[6].date).toBe('2026-03-09')
  })

  it('last7DayRows aggregates formula and diaper counts per day', () => {
    const model = buildReportModel(ALL_EVENTS, SETTINGS, NOW)
    const mar14 = model.last7DayRows.find(r => r.date === '2026-03-14')!
    // Timestamps constructed via localISO(2026, 2, 14, ...) so they land on
    // local Mar 14 in any runner timezone (no UTC+9 assumption).
    // 4 formula (06:00, 10:00, 14:00, 01:00) + 1 breast (08:00) = 5 feedings
    // formulaMl = 3*120 + 150 = 510
    expect(mar14.feedingCount).toBe(5)   // 4 formula + 1 breast
    expect(mar14.diaperCount).toBe(2)    // 1 pee + 1 poop
    expect(mar14.formulaMl).toBe(510)    // 3*120 + 150
  })

  it('returns empty/null gracefully with no settings', () => {
    const model = buildReportModel([], null, NOW)
    expect(model.babyName).toBe('')
    expect(model.growthRows).toHaveLength(0)
    expect(model.last7.avgFeedingPerDay).toBe(0)
  })

  it('deleted events are excluded', () => {
    const deletedFormula = makeEvent({ type: 'formula', at: '2026-03-14T05:00:00Z', data: { ml: 999 }, deleted: true })
    const model = buildReportModel([...ALL_EVENTS, deletedFormula], SETTINGS, NOW)
    // formulaMl should still be 660 not 660+999
    expect(model.last7.avgFormulaMlPerDay).toBeCloseTo(660 / 7, 1)
  })

  // MF-04: denominator clamped to days since birth for very young babies
  describe('MF-04: periodStats clamps denominator to days-since-birth', () => {
    it('baby 2 days old with 10 feedings: last7 avg = 5/day not 10/7', () => {
      // NOW = 2026-03-15, baby born 2026-03-13 → 2 days old
      const infantBirthdate = '2026-03-13'
      const infantSettings: AppSettings = {
        ...SETTINGS,
        baby: { ...SETTINGS.baby, birthdate: infantBirthdate },
      }

      // 10 feedings today and yesterday
      const feedings: DiaryEvent[] = Array.from({ length: 10 }, (_, i) =>
        makeEvent({
          type: 'formula',
          at: localISO(2026, 2, 14 + (i % 2 === 0 ? 0 : -1), 6 + i, 0),
          data: { ml: 100 },
        })
      )

      const model = buildReportModel(feedings, infantSettings, NOW)
      // effDays = min(7, 2+1) = 3 (birth day + 1 day elapsed = daysSinceBirth)
      // The infant is 2 days old (2026-03-13 to 2026-03-15 = 2 days diff + 1 = 3 effDays)
      // But only 2 of those days have feedings → feedings / 3 max (not /7)
      // Strictly: avgFeedingPerDay should be > 10/7 (≈1.43)
      expect(model.last7.avgFeedingPerDay).toBeGreaterThan(10 / 7)
    })

    it('baby older than 7 days: denominator stays at 7', () => {
      // Baby is 30 days old
      const olderSettings: AppSettings = {
        ...SETTINGS,
        baby: { ...SETTINGS.baby, birthdate: '2026-02-13' },
      }
      // 7 feedings in last 7 days
      const feedings = Array.from({ length: 7 }, (_, i) =>
        makeEvent({
          type: 'formula',
          at: localISO(2026, 2, 15 - i, 10, 0),
          data: { ml: 100 },
        })
      )
      const model = buildReportModel(feedings, olderSettings, NOW)
      expect(model.last7.avgFeedingPerDay).toBeCloseTo(7 / 7, 2)  // = 1.0
    })

    it('no birthdate: denominator stays at full window (no clamp)', () => {
      const noDateSettings: AppSettings | null = null
      const feedings = Array.from({ length: 7 }, (_, i) =>
        makeEvent({
          type: 'formula',
          at: localISO(2026, 2, 15 - i, 10, 0),
          data: { ml: 100 },
        })
      )
      const model = buildReportModel(feedings, noDateSettings, NOW)
      // No birthdate → no clamp → 7/7 = 1.0
      expect(model.last7.avgFeedingPerDay).toBeCloseTo(1.0, 2)
    })
  })

  // MF-05: WHO percentile null outside 0-24 months
  describe('MF-05: WHO percentile null outside 0-24 month range', () => {
    it('growth event at 26 months: weightPct and heightPct are null', () => {
      // Baby born 2024-01-15, measurement at 2026-03-15 = ~26 months
      const settings26mo: AppSettings = {
        ...SETTINGS,
        baby: { name: 'Test', birthdate: '2024-01-15', gender: 'boy' },
      }
      const growthAt26mo = makeEvent({
        type: 'growth',
        at: localISO(2026, 2, 15, 10, 0),
        data: { weightKg: 12.5, heightCm: 90.0 },
      })
      const model = buildReportModel([growthAt26mo], settings26mo, NOW)
      expect(model.growthRows).toHaveLength(1)
      expect(model.growthRows[0].weightPct).toBeNull()
      expect(model.growthRows[0].heightPct).toBeNull()
    })

    it('growth event at 24 months: still computes normally (boundary included)', () => {
      // Baby born 2024-03-15, measurement at NOW (2026-03-15) = exactly 24 months
      const settings24mo: AppSettings = {
        ...SETTINGS,
        baby: { name: 'Test', birthdate: '2024-03-15', gender: 'girl' },
      }
      const growthAt24mo = makeEvent({
        type: 'growth',
        at: localISO(2026, 2, 15, 10, 0),
        data: { weightKg: 11.0, heightCm: 86.0 },
      })
      const model = buildReportModel([growthAt24mo], settings24mo, NOW)
      expect(model.growthRows).toHaveLength(1)
      expect(model.growthRows[0].weightPct).not.toBeNull()
      expect(model.growthRows[0].heightPct).not.toBeNull()
    })

    it('growth event at 0 months (newborn): computes normally', () => {
      const settings0mo: AppSettings = {
        ...SETTINGS,
        baby: { name: 'Test', birthdate: '2026-03-15', gender: 'boy' },
      }
      const growthAt0mo = makeEvent({
        type: 'growth',
        at: localISO(2026, 2, 15, 10, 0),
        data: { weightKg: 3.5, heightCm: 50.0 },
      })
      const model = buildReportModel([growthAt0mo], settings0mo, NOW)
      expect(model.growthRows[0].weightPct).not.toBeNull()
    })
  })
})
