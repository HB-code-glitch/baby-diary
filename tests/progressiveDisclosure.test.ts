import { describe, expect, it } from 'vitest'
import type { DiaryEvent, EventType } from '../shared/types'
import * as progressiveDisclosure from '../src/lib/progressiveDisclosure'
import {
  getStatsVisibility,
  getSyncDisclosurePresentation,
  getVisibleHomeMetrics,
  partitionHomeInsights,
  partitionStatsPageSections,
  partitionStatsSections,
  shouldOpenSyncDisclosure,
} from '../src/lib/progressiveDisclosure'

function summaryEvent(id: string, type: EventType, at: Date, deleted = false): DiaryEvent {
  const iso = at.toISOString()
  const data = type === 'formula'
    ? { ml: 120 }
    : type === 'temp'
      ? { celsius: 37.2 }
      : type === 'breast'
        ? { side: 'L' as const }
        : {}
  return {
    id,
    type,
    at: iso,
    data,
    author: { uid: 'test', name: 'Tester', role: 'dad' },
    createdAt: iso,
    updatedAt: iso,
    rev: 1,
    deleted,
  } as DiaryEvent
}

describe('progressive Home disclosure', () => {
  it('selects only non-deleted records from the current local day and never mutates history', () => {
    const selectTodaySummaryEvents = (
      progressiveDisclosure as typeof progressiveDisclosure & {
        selectTodaySummaryEvents?: (
          events: readonly DiaryEvent[],
          options: { now: Date; birthdate?: string },
        ) => DiaryEvent[]
      }
    ).selectTodaySummaryEvents

    expect(selectTodaySummaryEvents).toBeTypeOf('function')
    if (!selectTodaySummaryEvents) return

    const now = new Date(2026, 6, 15, 12, 0)
    const history = [
      summaryEvent('pre-birth', 'formula', new Date(2026, 6, 1, 13, 0)),
      summaryEvent('yesterday', 'breast', new Date(2026, 6, 14, 23, 59)),
      summaryEvent('today-formula', 'formula', new Date(2026, 6, 15, 9, 0)),
      summaryEvent('today-temp', 'temp', new Date(2026, 6, 15, 11, 0)),
      summaryEvent('deleted-today', 'formula', new Date(2026, 6, 15, 10, 0), true),
      summaryEvent('future-today', 'formula', new Date(2026, 6, 15, 13, 0)),
    ]
    const unchanged = structuredClone(history)

    expect(selectTodaySummaryEvents(history, { now, birthdate: '2026-07-04' }).map(event => event.id))
      .toEqual(['today-temp', 'today-formula'])
    expect(history).toEqual(unchanged)
  })

  it('fails closed when a current-day record predates the configured birthdate', () => {
    const selectTodaySummaryEvents = (
      progressiveDisclosure as typeof progressiveDisclosure & {
        selectTodaySummaryEvents?: (
          events: readonly DiaryEvent[],
          options: { now: Date; birthdate?: string },
        ) => DiaryEvent[]
      }
    ).selectTodaySummaryEvents

    expect(selectTodaySummaryEvents).toBeTypeOf('function')
    if (!selectTodaySummaryEvents) return

    const now = new Date(2026, 6, 15, 12, 0)
    const impossibleCurrentSummary = [
      summaryEvent('before-birthdate', 'formula', new Date(2026, 6, 15, 9, 0)),
    ]

    expect(selectTodaySummaryEvents(impossibleCurrentSummary, {
      now,
      birthdate: '2026-07-16',
    })).toEqual([])
  })

  it('keeps Home disclosure translation keys aligned across both locales', async () => {
    const ko = await import('../src/i18n/ko.json')
    const ja = await import('../src/i18n/ja.json')
    const expectedKeys = [
      'summaryEmptyTitle',
      'summaryEmptyBody',
      'moreSummary',
      'lessSummary',
      'dailyTip',
    ]

    const koKeys = expectedKeys.filter(key => key in ko.home)
    const jaKeys = expectedKeys.filter(key => key in ja.home)

    expect(koKeys).toEqual(expectedKeys)
    expect(jaKeys).toEqual(expectedKeys)
    expect(koKeys).toEqual(jaKeys)
  })

  it('shows no metric placeholders when every current value is empty', () => {
    expect(getVisibleHomeMetrics({ formulaMl: 0, peeCount: 0, poopCount: 0, feedingCount: 0, hasTemperature: false })).toEqual([])
  })

  it('shows only metrics backed by current data', () => {
    expect(getVisibleHomeMetrics({ formulaMl: 120, peeCount: 2, poopCount: 0, feedingCount: 1, hasTemperature: false }))
      .toEqual(['formula', 'pee', 'feeding'])
  })

  it('keeps three priority insights and moves the rest behind disclosure', () => {
    expect(partitionHomeInsights({ hasLastFeeding: true, hasNextSide: true, hasDiaper: true, hasTemperature: true, hasSleep: true }))
      .toEqual({ primary: ['lastFeeding', 'diaper', 'temperature'], secondary: ['sleep', 'nextSide'] })
  })

  it('never promotes next-side ahead of feeding, diaper, and temperature', () => {
    const { primary } = partitionHomeInsights({
      hasLastFeeding: true,
      hasNextSide: true,
      hasDiaper: true,
      hasTemperature: true,
      hasSleep: false,
    })

    expect(primary).toEqual(['lastFeeding', 'diaper', 'temperature'])
    expect(primary).not.toContain('nextSide')
  })
})

it('enables only chart sections with data', () => {
  const visibility = getStatsVisibility([
    { sleepMinutes: 0, formulaMl: 0, feedingCount: 0, peeCount: 1, poopCount: 0, avgTemp: null },
    { sleepMinutes: 30, formulaMl: 0, feedingCount: 1, peeCount: 0, poopCount: 0, avgTemp: 37.2 },
  ])
  expect(visibility).toEqual({ sleep: true, formula: false, feeding: true, diaper: true, temperature: true })
  expect(partitionStatsSections(visibility)).toEqual({ primary: ['sleep', 'feeding'], secondary: ['diaper', 'temperature'] })
})

describe('progressive Stats disclosure', () => {
  it('keeps growth charts secondary when two daily charts already fill the primary limit', () => {
    expect(partitionStatsPageSections(
      { sleep: true, formula: true, feeding: false, diaper: false, temperature: false },
      { weight: true, height: true },
    )).toEqual({
      primary: ['sleep', 'formula'],
      secondary: ['growthWeight', 'growthHeight'],
    })
  })

  it('keeps both growth charts primary when there are no daily charts', () => {
    expect(partitionStatsPageSections(
      { sleep: false, formula: false, feeding: false, diaper: false, temperature: false },
      { weight: true, height: true },
    )).toEqual({
      primary: ['growthWeight', 'growthHeight'],
      secondary: [],
    })
  })

  it('shows no Stats sections when every day value is empty', () => {
    const visibility = getStatsVisibility([
      { sleepMinutes: 0, formulaMl: 0, feedingCount: 0, peeCount: 0, poopCount: 0, avgTemp: null },
      { sleepMinutes: 0, formulaMl: 0, feedingCount: 0, peeCount: 0, poopCount: 0, avgTemp: null },
    ])

    expect(partitionStatsSections(visibility)).toEqual({ primary: [], secondary: [] })
  })

  it('shows only the formula section when formula is the only recorded metric', () => {
    const visibility = getStatsVisibility([
      { sleepMinutes: 0, formulaMl: 120, feedingCount: 0, peeCount: 0, poopCount: 0, avgTemp: null },
    ])

    expect(partitionStatsSections(visibility)).toEqual({ primary: ['formula'], secondary: [] })
  })

  it('keeps Stats disclosure translation keys aligned across both locales', async () => {
    const ko = await import('../src/i18n/ko.json')
    const ja = await import('../src/i18n/ja.json')
    const expectedKeys = ['emptyTitle', 'emptyBody', 'moreSections', 'lessSections']

    const koKeys = expectedKeys.filter(key => key in ko.stats)
    const jaKeys = expectedKeys.filter(key => key in ja.stats)

    expect(koKeys).toEqual(expectedKeys)
    expect(jaKeys).toEqual(expectedKeys)
    expect(koKeys).toEqual(jaKeys)
  })
})

it('opens sync details only when attention is required', () => {
  expect(shouldOpenSyncDisclosure('off')).toBe(false)
  expect(shouldOpenSyncDisclosure('no-config')).toBe(true)
  expect(shouldOpenSyncDisclosure('online')).toBe(false)
  expect(shouldOpenSyncDisclosure('connecting')).toBe(false)
  expect(shouldOpenSyncDisclosure('signed-out')).toBe(true)
  expect(shouldOpenSyncDisclosure('error')).toBe(true)
})

describe('sync disclosure presentation', () => {
  it('opens with attention when sync is online without a family', () => {
    expect(getSyncDisclosurePresentation('online', false)).toEqual({
      summary: 'attention',
      defaultOpen: true,
    })
  })

  it('stays closed and ready when sync is online with a family', () => {
    expect(getSyncDisclosurePresentation('online', true)).toEqual({
      summary: 'ready',
      defaultOpen: false,
    })
  })

  it('stays closed while connecting', () => {
    expect(getSyncDisclosurePresentation('connecting', false)).toEqual({
      summary: 'connecting',
      defaultOpen: false,
    })
  })

  it('opens with attention on errors', () => {
    expect(getSyncDisclosurePresentation('error', true)).toEqual({
      summary: 'attention',
      defaultOpen: true,
    })
  })
})
