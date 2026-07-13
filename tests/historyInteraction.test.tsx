/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { format } from 'date-fns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiaryEvent, EventData, EventType } from '../shared/types'
import i18n from '../src/i18n'
import { HistoryPage } from '../src/pages/HistoryPage'
import { useAppStore } from '../src/store/useAppStore'

const NOW = new Date(2026, 6, 13, 12, 0, 0)

const EVENT_DATA: Record<EventType, EventData> = {
  pee: {},
  poop: {},
  temp: { celsius: 36.8 },
  breast: { side: 'L', minutes: 12 },
  formula: { ml: 120 },
  diary: { text: '오늘의 기록' },
  message: { text: '사랑해' },
  sleep: { minutes: 45 },
  growth: { weightKg: 6.2 },
}

function makeEvent(type: EventType, date: Date, hour: number, id = `${type}-${hour}`): DiaryEvent {
  const at = new Date(date)
  at.setHours(hour, 10, 0, 0)
  const timestamp = at.toISOString()
  return {
    id,
    type,
    at: timestamp,
    data: EVENT_DATA[type],
    author: { uid: 'test', name: 'Tester', role: 'mom' },
    createdAt: timestamp,
    updatedAt: timestamp,
    rev: 1,
    deleted: false,
  }
}

function byText<T extends HTMLElement>(container: HTMLElement, selector: string, text: string): T | undefined {
  return Array.from(container.querySelectorAll<T>(selector))
    .find(element => element.textContent?.trim() === text)
}

describe('History interactions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useAppStore.setState({ events: [], settings: null })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState({ events: [], settings: null })
    await i18n.changeLanguage('ko')
    vi.useRealTimers()
  })

  it.each([
    {
      locale: 'ko',
      tabs: ['월간', '주간', '하루'],
      previous: '이전 달',
      today: '오늘로 이동',
      next: '다음 달',
    },
    {
      locale: 'ja',
      tabs: ['月間', '週間', '1日'],
      previous: '前の月',
      today: '今日へ移動',
      next: '次の月',
    },
  ])('renders one localized shared toolbar in $locale', async ({ locale, tabs, previous, today, next }) => {
    await i18n.changeLanguage(locale)
    await act(async () => root.render(<HistoryPage />))

    const tablist = container.querySelector<HTMLElement>('[role="tablist"]')
    expect(tablist).not.toBeNull()
    const tabButtons = Array.from(tablist!.querySelectorAll<HTMLButtonElement>('[data-history-view]'))
    expect(tabButtons.map(button => button.textContent?.trim())).toEqual(tabs)
    expect(tabButtons.map(button => button.getAttribute('data-history-view'))).toEqual(['month', 'week', 'day'])
    expect(tabButtons[0].getAttribute('aria-selected')).toBe('true')

    expect(container.querySelectorAll('.history-period-nav')).toHaveLength(1)
    expect(container.querySelector('.cal-breadcrumb')).toBeNull()
    expect(container.querySelector(`button[aria-label="${previous}"]`)).not.toBeNull()
    expect(container.querySelector(`button[aria-label="${today}"]`)).not.toBeNull()
    expect(container.querySelector(`button[aria-label="${next}"]`)).not.toBeNull()
  })

  it('moves by exactly one month, week, or day and returns every view to today', async () => {
    await act(async () => root.render(<HistoryPage />))
    const title = () => container.querySelector('.history-period-nav .cal-nav-title')?.textContent?.trim()

    expect(title()).toBe('2026년 7월')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="이전 달"]')!.click())
    expect(title()).toBe('2026년 6월')
    expect(container.querySelector('[data-history-preview]')?.textContent).toContain('2026년 6월 13일')
    expect(container.querySelector('[data-history-date="2026-06-13"]')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="다음 달"]')!.click())
    expect(title()).toBe('2026년 7월')
    expect(container.querySelector('[data-history-preview]')?.textContent).toContain('2026년 7월 13일')

    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="week"]')!.click())
    expect(title()).toBe('7월 12일 ~ 18일')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="이전 주"]')!.click())
    expect(title()).toBe('7월 5일 ~ 11일')
    expect(container.querySelector('[data-history-preview]')?.textContent).toContain('2026년 7월 6일')
    expect(container.querySelector('[data-history-date="2026-07-06"]')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="다음 주"]')!.click())
    expect(title()).toBe('7월 12일 ~ 18일')
    expect(container.querySelector('[data-history-preview]')?.textContent).toContain('2026년 7월 13일')

    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="day"]')!.click())
    expect(title()).toBe('2026년 7월 13일 (월)')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="이전 날"]')!.click())
    expect(title()).toBe('2026년 7월 12일 (일)')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="다음 날"]')!.click())
    expect(title()).toBe('2026년 7월 13일 (월)')
  })

  it('keeps the preview and displayed month together when selecting an overflow cell', async () => {
    await act(async () => root.render(<HistoryPage />))
    const overflowCell = container.querySelector<HTMLButtonElement>('.cal-day-cell.cal-day-other-month')!
    const selectedDate = overflowCell.getAttribute('data-history-date')!
    const selected = new Date(`${selectedDate}T12:00:00`)

    await act(async () => overflowCell.click())

    expect(container.querySelector('[data-history-view="month"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('.history-period-nav .cal-nav-title')?.textContent).toBe(
      `${selected.getFullYear()}년 ${selected.getMonth() + 1}월`,
    )
    expect(container.querySelector(`[data-history-date="${selectedDate}"]`)?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-history-preview]')?.textContent).toContain(
      `${selected.getFullYear()}년 ${selected.getMonth() + 1}월 ${selected.getDate()}일`,
    )
  })

  it('uses calendar month clamping at the end of a month', async () => {
    vi.setSystemTime(new Date(2026, 0, 31, 12, 0, 0))
    await act(async () => root.render(<HistoryPage />))

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="다음 달"]')!.click())

    expect(container.querySelector('.history-period-nav .cal-nav-title')?.textContent).toBe('2026년 2월')
    expect(container.querySelector('[data-history-date="2026-02-28"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-history-preview]')?.textContent).toContain('2026년 2월 28일')
  })

  it('keeps month and week selections in place and exposes a newest-three preview', async () => {
    const selected = new Date(2026, 6, 12, 12, 0, 0)
    const events = [
      makeEvent('pee', selected, 8),
      makeEvent('formula', selected, 10),
      makeEvent('sleep', selected, 12),
      makeEvent('growth', selected, 14),
    ]
    useAppStore.setState({ events })
    await act(async () => root.render(<HistoryPage />))

    const date = format(selected, 'yyyy-MM-dd')
    const monthCell = container.querySelector<HTMLButtonElement>(`.cal-day-cell[data-history-date="${date}"]`)!
    await act(async () => monthCell.click())

    expect(container.querySelector('[data-history-view="month"]')?.getAttribute('aria-selected')).toBe('true')
    expect(monthCell.getAttribute('aria-pressed')).toBe('true')
    expect(monthCell.getAttribute('aria-label')).toContain('4건')
    expect(monthCell.getAttribute('aria-label')).toContain('소변 1')
    expect(monthCell.querySelector('.cal-day-event-count')?.textContent).toBe('4건')

    const preview = container.querySelector<HTMLElement>('[data-history-preview]')!
    expect(preview.textContent).toContain('선택한 날 기록')
    expect(preview.textContent).toContain('총 4건')
    expect(preview.querySelectorAll('.timeline-item')).toHaveLength(3)

    const weekTab = container.querySelector<HTMLButtonElement>('[data-history-view="week"]')!
    await act(async () => weekTab.click())
    const weekRow = container.querySelector<HTMLButtonElement>(`.cal-week-row[data-history-date="${date}"]`)!
    await act(async () => weekRow.click())

    expect(weekTab.getAttribute('aria-selected')).toBe('true')
    expect(weekRow.getAttribute('aria-pressed')).toBe('true')
    expect(weekRow.textContent).toContain('4건')
    expect(weekRow.textContent).toContain('소변 1')
    expect(weekRow.querySelector('.cal-week-times')).toBeNull()

    const openDay = byText<HTMLButtonElement>(container, 'button', '전체 기록 보기')!
    await act(async () => openDay.click())
    expect(container.querySelector('[data-history-view="day"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelectorAll('.cal-day .timeline-item')).toHaveLength(4)
  })

  it('shows counts for all nine event filters only when those types exist', async () => {
    const events = (Object.keys(EVENT_DATA) as EventType[])
      .map((type, index) => makeEvent(type, NOW, index + 1))
    useAppStore.setState({ events })
    await act(async () => root.render(<HistoryPage />))

    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="week"]')!.click())
    const weekRow = container.querySelector<HTMLElement>('.cal-week-row.cal-week-row-today')!
    expect(weekRow.querySelector('.cal-week-summary')?.textContent).toBe('소변 1 · 대변 1 · 체온 기록 1 · 외 6종')
    expect(weekRow.getAttribute('aria-label')).toContain('성장 1')

    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="day"]')!.click())

    const filters = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-history-filter]'))
    expect(filters.map(button => button.getAttribute('data-history-filter'))).toEqual([
      'all', 'pee', 'poop', 'temp', 'breast', 'formula', 'diary', 'message', 'sleep', 'growth',
    ])
    expect(filters.map(button => button.textContent?.trim())).toEqual([
      '전체 9', '소변 1', '대변 1', '체온 1', '모유 1', '분유 1', '일기 1', '아기에게 1', '수면 1', '성장 1',
    ])
  })

  it('uses History-specific copy when the selected day has no records', async () => {
    await act(async () => root.render(<HistoryPage />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="day"]')!.click())

    const empty = container.querySelector<HTMLElement>('.cal-day .empty-state')!
    expect(empty.textContent).toContain('선택한 날짜에 기록이 없어요')
    expect(empty.textContent).not.toContain('오늘')
    expect(empty.textContent).not.toContain('위 버튼')
  })
})
