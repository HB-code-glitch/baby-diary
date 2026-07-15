/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, DiaryEvent, EventType } from '../shared/types'
import i18n from '../src/i18n'
import { ToastProvider } from '../src/components/Toast'
import { HomePage } from '../src/pages/HomePage'
import { useAppStore } from '../src/store/useAppStore'

vi.mock('../src/sync/useSync', () => ({
  useSyncStatus: () => ({ status: 'online', detail: 'test', pendingCount: 0 }),
}))

const SETTINGS: AppSettings = {
  baby: { name: '재이', birthdate: '2026-07-04', gender: 'girl' },
  profile: { uid: 'dad-test', name: '아빠', role: 'dad' },
  familyId: 'family-test',
  firebase: null,
  language: 'ko',
  theme: 'dark',
}

function event(id: string, type: EventType, at: Date): DiaryEvent {
  const iso = at.toISOString()
  const data = type === 'formula'
    ? { ml: 120 }
    : type === 'temp'
      ? { celsius: 37.2 }
      : {}
  return {
    id,
    type,
    at: iso,
    data,
    author: { uid: 'dad-test', name: '아빠', role: 'dad' },
    createdAt: iso,
    updatedAt: iso,
    rev: 1,
    deleted: false,
  } as DiaryEvent
}

describe('Home current-day summary', () => {
  let container: HTMLDivElement
  let root: Root
  let history: DiaryEvent[]

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0))
    localStorage.clear()
    await i18n.changeLanguage('ko')

    history = [
      event('pre-birth-formula', 'formula', new Date(2026, 6, 1, 13, 0)),
      event('pre-birth-temp', 'temp', new Date(2026, 6, 1, 13, 30)),
      event('today-pee', 'pee', new Date(2026, 6, 15, 10, 0)),
    ]
    useAppStore.setState({
      events: history,
      settings: SETTINGS,
      dataInfo: null,
      isReady: true,
      isLoading: false,
      error: null,
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState({ events: [], settings: null, dataInfo: null, isReady: false })
    localStorage.clear()
    vi.useRealTimers()
  })

  async function renderHome(): Promise<void> {
    await act(async () => {
      root.render(
        <ToastProvider>
          <HomePage />
        </ToastProvider>,
      )
    })
  }

  it('does not surface historical or pre-birth feeding and temperature records in Today Summary', async () => {
    const unchanged = structuredClone(history)

    await renderHome()

    const summary = container.querySelector<HTMLElement>('.insights-panel')
    expect(summary).not.toBeNull()
    expect(summary?.textContent).not.toContain('13:00')
    expect(summary?.textContent).not.toContain('37.2')
    expect(summary?.querySelectorAll('.insight-row')).toHaveLength(1)
    expect(history).toEqual(unchanged)
  })

  it('renders Today Summary before the current-needs guidance in DOM order', async () => {
    await renderHome()

    const stack = container.querySelector<HTMLElement>('.home-insight-stack')
    const summary = stack?.querySelector<HTMLElement>('.insights-panel')
    const currentNeeds = stack?.querySelector<HTMLElement>('.age-guidance-panel')
    expect(stack).not.toBeNull()
    expect(summary).not.toBeNull()
    expect(currentNeeds).not.toBeNull()

    const children = Array.from(stack?.children ?? [])
    expect(children.indexOf(summary!)).toBeLessThan(children.indexOf(currentNeeds!))
  })

  it('names the shared insight landmark for both Today Summary and current-needs guidance', async () => {
    await renderHome()

    const stack = container.querySelector<HTMLElement>('aside.home-insight-stack')
    const label = stack?.getAttribute('aria-label') ?? ''

    expect(label).toContain(i18n.t('home.insightsTitle'))
    expect(label).toContain(i18n.t('ageGuidance.title'))
  })
})
