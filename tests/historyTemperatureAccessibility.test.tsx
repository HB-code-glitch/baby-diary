/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { format } from 'date-fns'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiaryEvent } from '../shared/types'
import i18n from '../src/i18n'
import { HistoryPage } from '../src/pages/HistoryPage'
import { useAppStore } from '../src/store/useAppStore'

function accessibleName(element: HTMLElement): string {
  return element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''
}

describe('history temperature-record accessibility', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
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
  })

  it.each([
    { locale: 'ko', temperatureLabel: '체온 기록', weekLabel: '주' },
    { locale: 'ja', temperatureLabel: '体温記録', weekLabel: '週' },
  ])('includes $locale temperature presence in month and week accessible names', async ({ locale, temperatureLabel, weekLabel }) => {
    const recordedAt = new Date()
    recordedAt.setHours(10, 30, 0, 0)
    const timestamp = recordedAt.toISOString()
    const event: DiaryEvent = {
      id: `temperature-${locale}`,
      type: 'temp',
      at: timestamp,
      data: { celsius: 36.8 },
      author: { uid: 'test', name: 'Tester', role: 'mom' },
      createdAt: timestamp,
      updatedAt: timestamp,
      rev: 1,
      deleted: false,
    }
    useAppStore.setState({ events: [event] })
    await i18n.changeLanguage(locale)

    await act(async () => {
      root.render(<HistoryPage />)
    })

    const dateLabel = format(recordedAt, 'yyyy-MM-dd')
    const monthButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.cal-day-cell'))
    const recordedDay = monthButtons.find(button => accessibleName(button) === `${dateLabel} ${temperatureLabel}`)
    expect(recordedDay).toBeDefined()
    expect(monthButtons.some(button => /^\d{4}-\d{2}-\d{2}$/.test(accessibleName(button)))).toBe(true)

    const weekSwitcher = Array.from(container.querySelectorAll<HTMLButtonElement>('.cal-view-btn'))
      .find(button => accessibleName(button) === weekLabel)!
    await act(async () => weekSwitcher.click())

    const weekRows = Array.from(container.querySelectorAll<HTMLButtonElement>('.cal-week-row'))
    const recordedWeekDay = weekRows.find(button => accessibleName(button).includes(temperatureLabel))
    expect(recordedWeekDay).toBeDefined()
  })
})
