import { describe, expect, it } from 'vitest'
import {
  getStatsVisibility,
  getVisibleHomeMetrics,
  partitionHomeInsights,
  partitionStatsSections,
  shouldOpenSyncDisclosure,
} from '../src/lib/progressiveDisclosure'

describe('progressive Home disclosure', () => {
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

it('opens sync details only when attention is required', () => {
  expect(shouldOpenSyncDisclosure('off')).toBe(false)
  expect(shouldOpenSyncDisclosure('no-config')).toBe(true)
  expect(shouldOpenSyncDisclosure('online')).toBe(false)
  expect(shouldOpenSyncDisclosure('connecting')).toBe(false)
  expect(shouldOpenSyncDisclosure('signed-out')).toBe(true)
  expect(shouldOpenSyncDisclosure('error')).toBe(true)
})
