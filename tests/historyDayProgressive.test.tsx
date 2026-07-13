/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiaryEvent, EventType } from '../shared/types'
import i18n from '../src/i18n'
import { HistoryPage } from '../src/pages/HistoryPage'
import { useAppStore } from '../src/store/useAppStore'

const NOW = new Date(2026, 6, 13, 12, 0, 0)

function makeEvents(
  type: EventType,
  count: number,
  dayOffset = 0,
  prefix = type,
  minuteOffset = 0,
): DiaryEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(2026, 6, 13 + dayOffset, 23, 59 - minuteOffset - index, 0, 0)
    const timestamp = at.toISOString()
    return {
      id: `${prefix}-${index}`,
      mutationId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
      type,
      at: timestamp,
      data: type === 'temp' ? { celsius: 36.8 } : {},
      author: { uid: 'test', name: 'Tester', role: 'mom' },
      createdAt: timestamp,
      updatedAt: timestamp,
      rev: 1,
      deleted: false,
    } as DiaryEvent
  })
}

describe('History day progressive timeline', () => {
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

  async function openDayView() {
    await act(async () => root.render(<HistoryPage />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-view="day"]')!.click())
  }

  it('renders at most 48 records first and focuses the first newly revealed record', async () => {
    useAppStore.setState({ events: makeEvents('pee', 120, 0, 'pee') })
    await openDayView()

    expect(container.querySelectorAll('.cal-day .timeline-item')).toHaveLength(48)
    const loadMore = container.querySelector<HTMLButtonElement>('[data-list-load-more="history-day"]')!
    expect(loadMore.getAttribute('data-list-remaining')).toBe('72')

    loadMore.focus()
    await act(async () => loadMore.click())

    expect(container.querySelectorAll('.cal-day .timeline-item')).toHaveLength(96)
    expect(document.activeElement).toBe(
      container.querySelector('[data-event-id="pee-48"] [data-event-action="edit"]'),
    )
  })

  it('resets the 48-record window when the selected date changes', async () => {
    useAppStore.setState({
      events: [
        ...makeEvents('pee', 120, 0, 'today'),
        ...makeEvents('pee', 80, 1, 'tomorrow'),
      ],
    })
    await openDayView()

    await act(async () => container.querySelector<HTMLButtonElement>('[data-list-load-more="history-day"]')!.click())
    expect(container.querySelectorAll('.cal-day .timeline-item')).toHaveLength(96)

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="다음 날"]')!.click())

    expect(container.querySelectorAll('.cal-day .timeline-item')).toHaveLength(48)
    expect(container.querySelector('[data-event-id="tomorrow-0"]')).not.toBeNull()
    expect(container.querySelector('[data-event-id="today-0"]')).toBeNull()
  })

  it('resets the 48-record window whenever the event-type filter changes', async () => {
    useAppStore.setState({
      events: [
        ...makeEvents('pee', 60, 0, 'pee'),
        ...makeEvents('poop', 60, 0, 'poop', 120),
      ],
    })
    await openDayView()

    await act(async () => container.querySelector<HTMLButtonElement>('[data-list-load-more="history-day"]')!.click())
    expect(container.querySelectorAll('.cal-day .timeline-item')).toHaveLength(96)

    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-filter="pee"]')!.click())
    expect(container.querySelectorAll('.cal-day .timeline-item')).toHaveLength(48)

    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-filter="all"]')!.click())
    expect(container.querySelectorAll('.cal-day .timeline-item')).toHaveLength(48)
  })

  it.each([
    ['ko', '기록 더 보기 (12개)'],
    ['ja', 'さらに表示（12件）'],
  ] as const)('uses an accessible localized load control in %s', async (language, expectedLabel) => {
    await i18n.changeLanguage(language)
    useAppStore.setState({ events: makeEvents('pee', 60) })
    await openDayView()

    const loadMore = container.querySelector<HTMLButtonElement>('[data-list-load-more="history-day"]')!
    expect(loadMore.type).toBe('button')
    expect(loadMore.textContent?.trim()).toBe(expectedLabel)
  })
})
