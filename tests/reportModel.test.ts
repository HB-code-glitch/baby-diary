import { describe, it, expect } from 'vitest'
import { buildReportModel } from '../src/lib/reportModel'
import type { DiaryEvent, AppSettings } from '../shared/types'

// Fixed "now" for deterministic date math
const NOW = new Date('2026-03-15T12:00:00.000Z')

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
const FORMULA_EVENTS: DiaryEvent[] = [
  // day -1 (2026-03-14): 3 feedings at 120ml each
  makeEvent({ type: 'formula', at: '2026-03-14T06:00:00Z', data: { ml: 120 } }),
  makeEvent({ type: 'formula', at: '2026-03-14T10:00:00Z', data: { ml: 120 } }),
  makeEvent({ type: 'formula', at: '2026-03-14T14:00:00Z', data: { ml: 120 } }),
  // day -2 (2026-03-13): 2 feedings at 150ml each
  makeEvent({ type: 'formula', at: '2026-03-13T08:00:00Z', data: { ml: 150 } }),
  makeEvent({ type: 'formula', at: '2026-03-13T16:00:00Z', data: { ml: 150 } }),
]
const BREAST_EVENTS: DiaryEvent[] = [
  makeEvent({ type: 'breast', at: '2026-03-14T08:00:00Z', data: { side: 'L' } }),
]
const DIAPER_EVENTS: DiaryEvent[] = [
  makeEvent({ type: 'pee',  at: '2026-03-14T07:00:00Z', data: {} }),
  makeEvent({ type: 'poop', at: '2026-03-14T09:00:00Z', data: {} }),
  makeEvent({ type: 'pee',  at: '2026-03-13T07:00:00Z', data: {} }),
]
const SLEEP_EVENTS: DiaryEvent[] = [
  makeEvent({ type: 'sleep', at: '2026-03-14T20:00:00Z', data: { minutes: 480 } }),
  makeEvent({ type: 'sleep', at: '2026-03-13T20:00:00Z', data: { minutes: 360 } }),
]
const TEMP_EVENTS: DiaryEvent[] = [
  makeEvent({ type: 'temp', at: '2026-03-14T08:00:00Z', data: { celsius: 37.5 } }),
  makeEvent({ type: 'temp', at: '2026-03-14T20:00:00Z', data: { celsius: 38.2 } }),
  makeEvent({ type: 'temp', at: '2026-03-13T08:00:00Z', data: { celsius: 37.0 } }),
]
const GROWTH_EVENTS: DiaryEvent[] = [
  makeEvent({ type: 'growth', at: '2026-02-15T10:00:00Z', data: { weightKg: 6.8, heightCm: 65.0 } }),
  makeEvent({ type: 'growth', at: '2026-03-01T10:00:00Z', data: { weightKg: 7.2, heightCm: 66.5 } }),
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
    // In UTC+9 timezone, 2026-03-13T16:00Z = 2026-03-14T01:00+09:00
    // So 4 formula + 1 breast = 5 feedings, formulaMl = 3*120+150 = 510
    expect(mar14.feedingCount).toBe(5)   // 4 formula + 1 breast (tz-adjusted)
    expect(mar14.diaperCount).toBe(2)    // 1 pee + 1 poop
    expect(mar14.formulaMl).toBe(510)    // 3*120 + 150 (tz-adjusted)
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
})
