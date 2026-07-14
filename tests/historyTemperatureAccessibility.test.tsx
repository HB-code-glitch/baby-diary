/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { format } from 'date-fns'
import { ja, ko } from 'date-fns/locale'
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
    { locale: 'ko', temperatureLabel: '체온 기록', weekLabel: '주간', countLabel: '1건' },
    { locale: 'ja', temperatureLabel: '体温記録', weekLabel: '週間', countLabel: '1件' },
  ])('includes $locale temperature presence in month and week accessible names', async ({ locale, temperatureLabel, weekLabel, countLabel }) => {
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

    const dateLabel = format(recordedAt, i18n.t('date.formatFull'), {
      locale: locale === 'ja' ? ja : ko,
    })
    const monthButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.cal-day-cell'))
    const recordedDay = monthButtons.find(button => {
      const name = accessibleName(button)
      return name.includes(dateLabel) && name.includes(countLabel) && name.includes(temperatureLabel)
    })
    expect(recordedDay).toBeDefined()
    expect(monthButtons.some(button => accessibleName(button).includes(locale === 'ja' ? '記録なし' : '기록 없음'))).toBe(true)

    const weekSwitcher = Array.from(container.querySelectorAll<HTMLButtonElement>('.cal-view-btn'))
      .find(button => accessibleName(button) === weekLabel)!
    await act(async () => weekSwitcher.click())

    const weekRows = Array.from(container.querySelectorAll<HTMLButtonElement>('.cal-week-row'))
    const recordedWeekDay = weekRows.find(button => accessibleName(button).includes(temperatureLabel))
    expect(recordedWeekDay).toBeDefined()
  })
})
