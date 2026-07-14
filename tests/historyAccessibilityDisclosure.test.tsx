/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { format } from 'date-fns'
import { ja, ko } from 'date-fns/locale'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiaryEvent, EventType } from '../shared/types'
import i18n from '../src/i18n'
import { HistoryPage } from '../src/pages/HistoryPage'
import { useAppStore } from '../src/store/useAppStore'

const NOW = new Date(2026, 6, 13, 12, 0, 0)

function makeEvent(type: EventType, hour: number, id = `${type}-${hour}`): DiaryEvent {
  const at = new Date(NOW)
  at.setHours(hour, 10, 0, 0)
  const timestamp = at.toISOString()
  const data = type === 'temp'
    ? { celsius: 36.8 }
    : type === 'formula'
      ? { ml: 120 }
      : {}
  return {
    id,
    type,
    at: timestamp,
    data,
    author: { uid: 'test', name: 'Tester', role: 'mom' },
    createdAt: timestamp,
    updatedAt: timestamp,
    rev: 1,
    deleted: false,
  } as DiaryEvent
}

function dispatchKey(element: HTMLElement, key: string, shiftKey = false) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
}

describe('History progressive disclosure and calendar accessibility', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useAppStore.setState({ events: [], settings: null })
    await i18n.changeLanguage('ko')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState({ events: [], settings: null })
    await i18n.changeLanguage('ko')
    vi.useRealTimers()
  })

  it('hides empty-day actions while preserving the detail route for any recorded event', async () => {
    await act(async () => root.render(<HistoryPage />))
    expect(container.querySelector('[data-history-preview-action]')).toBeNull()

    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="day"]')!.click())
    expect(container.querySelector('[data-history-filters]')).toBeNull()

    await act(async () => useAppStore.setState({ events: [makeEvent('pee', 8, 'pee-1')] }))
    await act(async () => root.render(<HistoryPage />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="month"]')!.click())
    expect(container.querySelector('[data-history-preview-action]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="day"]')!.click())
    expect(container.querySelector('[data-history-filters]')).toBeNull()

    await act(async () => useAppStore.setState({ events: [
      makeEvent('pee', 7, 'pee-0'),
      makeEvent('pee', 8, 'pee-1'),
      makeEvent('pee', 9, 'pee-2'),
      makeEvent('pee', 10, 'pee-3'),
    ] }))
    await act(async () => root.render(<HistoryPage />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="month"]')!.click())
    expect(container.querySelector('[data-history-preview-action]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="day"]')!.click())
    expect(container.querySelector('[data-history-filters]')).toBeNull()
  })

  it('shows type filters only when at least two recorded types make filtering useful', async () => {
    useAppStore.setState({ events: [makeEvent('pee', 8), makeEvent('poop', 9)] })
    await act(async () => root.render(<HistoryPage />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="day"]')!.click())

    const filterGroup = container.querySelector<HTMLElement>('[data-history-filters]')
    expect(filterGroup).not.toBeNull()
    expect(Array.from(filterGroup!.querySelectorAll('[data-history-filter]')).map(element => (
      element.getAttribute('data-history-filter')
    ))).toEqual(['all', 'pee', 'poop'])
  })

  it('falls back to all records when the selected filter type disappears', async () => {
    const pee = makeEvent('pee', 8)
    const poop = makeEvent('poop', 9)
    useAppStore.setState({ events: [pee, poop] })
    await act(async () => root.render(<HistoryPage />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="day"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-filter="pee"]')!.click())
    expect(container.querySelector(`[data-event-id="${pee.id}"]`)).not.toBeNull()

    await act(async () => useAppStore.setState({ events: [poop] }))
    await act(async () => root.render(<HistoryPage />))

    expect(container.querySelector('[data-history-filters]')).toBeNull()
    expect(container.querySelector(`[data-event-id="${poop.id}"]`)).not.toBeNull()
  })

  it.each([
    { locale: 'ko', localeObject: ko, todayWord: '오늘', gridName: '2026년 7월 달력. 화살표 키로 날짜 이동' },
    { locale: 'ja', localeObject: ja, todayWord: '今日', gridName: '2026年7月のカレンダー。矢印キーで日付を移動' },
  ])('exposes one roving date stop and a localized full-date name in $locale', async ({ locale, localeObject, todayWord, gridName }) => {
    await i18n.changeLanguage(locale)
    await act(async () => root.render(<HistoryPage />))

    expect(container.querySelector('h1')?.textContent).toBe(i18n.t('history.title'))
    const grid = container.querySelector<HTMLElement>('[data-history-month-grid]')!
    expect(grid.getAttribute('role')).toBe('grid')
    expect(grid.getAttribute('aria-label')).toBe(gridName)
    const dateCells = Array.from(grid.querySelectorAll<HTMLButtonElement>('.cal-day-cell'))
    expect(dateCells.filter(cell => cell.tabIndex === 0)).toHaveLength(1)

    const today = grid.querySelector<HTMLButtonElement>('[data-history-date="2026-07-13"]')!
    expect(today.tabIndex).toBe(0)
    expect(today.getAttribute('aria-current')).toBe('date')
    expect(today.getAttribute('aria-label')).toContain(format(NOW, i18n.t('date.formatFull'), { locale: localeObject }))
    expect(today.getAttribute('aria-label')).toContain(todayWord)
    expect(today.getAttribute('aria-selected')).toBe('true')
  })

  it('moves selection and focus with date-grid keyboard conventions', async () => {
    await act(async () => root.render(<HistoryPage />))

    const selected = () => container.querySelector<HTMLButtonElement>('.cal-day-cell[aria-selected="true"]')!
    const expectSelectedAndFocused = (date: string) => {
      const cell = container.querySelector<HTMLButtonElement>(`.cal-day-cell[data-history-date="${date}"]`)!
      expect(cell.getAttribute('aria-selected')).toBe('true')
      expect(cell.tabIndex).toBe(0)
      expect(document.activeElement).toBe(cell)
      expect(Array.from(container.querySelectorAll<HTMLButtonElement>('.cal-day-cell')).filter(day => day.tabIndex === 0)).toHaveLength(1)
    }

    selected().focus()
    await act(async () => dispatchKey(selected(), 'ArrowRight'))
    expectSelectedAndFocused('2026-07-14')
    await act(async () => dispatchKey(selected(), 'ArrowDown'))
    expectSelectedAndFocused('2026-07-21')
    await act(async () => dispatchKey(selected(), 'Home'))
    expectSelectedAndFocused('2026-07-19')
    await act(async () => dispatchKey(selected(), 'End'))
    expectSelectedAndFocused('2026-07-25')
    await act(async () => dispatchKey(selected(), 'PageUp'))
    expectSelectedAndFocused('2026-06-25')
    expect(container.querySelector('.cal-nav-title')?.textContent).toBe('2026년 6월')
    await act(async () => dispatchKey(selected(), 'PageDown', true))
    expectSelectedAndFocused('2027-06-25')
    expect(container.querySelector('.cal-nav-title')?.textContent).toBe('2027년 6월')
  })

  it.each([
    {
      locale: 'ko',
      cases: [
        [new Date(2026, 6, 13, 12), '2026년 7월 12일 ~ 18일'],
        [new Date(2026, 6, 1, 12), '2026년 6월 28일 ~ 7월 4일'],
        [new Date(2026, 0, 1, 12), '2025년 12월 28일 ~ 2026년 1월 3일'],
      ] as const,
    },
    {
      locale: 'ja',
      cases: [
        [new Date(2026, 6, 13, 12), '2026年7月12日〜18日'],
        [new Date(2026, 6, 1, 12), '2026年6月28日〜7月4日'],
        [new Date(2026, 0, 1, 12), '2025年12月28日〜2026年1月3日'],
      ] as const,
    },
  ])('always includes an unambiguous year in $locale week titles', async ({ locale, cases }) => {
    await i18n.changeLanguage(locale)
    for (const [date, expected] of cases) {
      vi.setSystemTime(date)
      await act(async () => root.render(<HistoryPage key={date.toISOString()} />))
      await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="week"]')!.click())
      expect(container.querySelector('.cal-nav-title')?.textContent).toBe(expected)
    }
  })
})
