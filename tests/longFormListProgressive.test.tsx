/** @vitest-environment jsdom */

import fs from 'node:fs'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, DiaryData, DiaryEvent, MessageData } from '../shared/types'
import i18n from '../src/i18n'
import { DiaryPage } from '../src/pages/DiaryPage'
import { MessagesPage } from '../src/pages/MessagesPage'
import { useAppStore } from '../src/store/useAppStore'

const SETTINGS: AppSettings = {
  baby: { name: '하루', birthdate: '2024-01-01' },
  profile: { uid: 'tester', name: '보호자', role: 'mom' },
  familyId: '',
  firebase: null,
}
const BASE_TIME = new Date('2026-07-13T10:00:00.000Z').getTime()
const originalStore = useAppStore.getState()

function makeEvent(type: 'diary' | 'message', index: number): DiaryEvent {
  const timestamp = new Date(BASE_TIME - index * 60_000).toISOString()
  return {
    id: `${type}-${index}`,
    mutationId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    type,
    at: timestamp,
    data: type === 'diary'
      ? ({ title: `제목 ${index}`, text: `일기 ${index}` } satisfies DiaryData)
      : ({ text: `편지 ${index}` } satisfies MessageData),
    author: { uid: 'tester', name: '보호자', role: 'mom' },
    createdAt: timestamp,
    updatedAt: timestamp,
    rev: 1,
    deleted: false,
  }
}

describe('Diary and Messages progressive long lists', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useAppStore.setState({
      events: [],
      settings: SETTINGS,
      addEvent: vi.fn(async event => event),
      editEvent: vi.fn(async event => event),
      softDeleteEvent: vi.fn(async event => event),
    })
    await i18n.changeLanguage('ko')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState({
      events: originalStore.events,
      settings: originalStore.settings,
      addEvent: originalStore.addEvent,
      editEvent: originalStore.editEvent,
      softDeleteEvent: originalStore.softDeleteEvent,
    })
    await i18n.changeLanguage('ko')
  })

  it('caps the initial Diary DOM for 1,000 records and bounds every entrance delay', async () => {
    useAppStore.setState({ events: Array.from({ length: 1_000 }, (_, index) => makeEvent('diary', index)) })
    await act(async () => root.render(<DiaryPage />))

    const entries = Array.from(container.querySelectorAll<HTMLElement>('[data-diary-entry]'))
    expect(entries).toHaveLength(48)
    expect(container.querySelector('[data-list-load-more="diary"]')).not.toBeNull()
    expect(entries.at(-1)?.style.getPropertyValue('--stagger-delay')).toBe('336ms')
    expect(entries.every(entry => !entry.style.getPropertyValue('--i'))).toBe(true)
  })

  it('reveals Diary records progressively without moving the scroll position or a surviving control focus', async () => {
    useAppStore.setState({ events: Array.from({ length: 120 }, (_, index) => makeEvent('diary', index)) })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 777 })
    await act(async () => root.render(<DiaryPage />))

    const loadMore = container.querySelector<HTMLButtonElement>('[data-list-load-more="diary"]')!
    loadMore.focus()
    await act(async () => loadMore.click())

    expect(container.querySelectorAll('[data-diary-entry]')).toHaveLength(96)
    expect(window.scrollY).toBe(777)
    expect(document.activeElement).toBe(loadMore)
  })

  it('moves focus without scrolling to the first newly revealed action when the final load control disappears', async () => {
    useAppStore.setState({ events: Array.from({ length: 60 }, (_, index) => makeEvent('diary', index)) })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 555 })
    await act(async () => root.render(<DiaryPage />))

    const loadMore = container.querySelector<HTMLButtonElement>('[data-list-load-more="diary"]')!
    loadMore.focus()
    await act(async () => loadMore.click())

    expect(container.querySelectorAll('[data-diary-entry]')).toHaveLength(60)
    expect(container.querySelector('[data-list-load-more="diary"]')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[data-diary-action="edit"][data-event-id="diary-48"]'))
    expect(window.scrollY).toBe(555)
  })

  it('keeps a newly synced Diary record visible while retaining the bounded window', async () => {
    const original = Array.from({ length: 100 }, (_, index) => makeEvent('diary', index))
    useAppStore.setState({ events: original })
    await act(async () => root.render(<DiaryPage />))

    const newest = {
      ...makeEvent('diary', 2_000),
      id: 'newly-synced',
      at: new Date(BASE_TIME + 60_000).toISOString(),
    }
    await act(async () => useAppStore.setState({ events: [...original, newest] }))

    expect(container.querySelectorAll('[data-diary-entry]')).toHaveLength(48)
    expect(container.querySelector('[data-diary-entry][data-event-id="newly-synced"]')).not.toBeNull()
  })

  it('restores focus to the next Diary action after deleting the focused record', async () => {
    const events = Array.from({ length: 3 }, (_, index) => makeEvent('diary', index))
    useAppStore.setState({
      events,
      softDeleteEvent: vi.fn(async event => {
        useAppStore.setState(state => ({ events: state.events.filter(candidate => candidate.id !== event.id) }))
        return { ...event, deleted: true }
      }),
    })
    await act(async () => root.render(<DiaryPage />))

    const deleteNewest = container.querySelector<HTMLButtonElement>(
      '[data-diary-action="delete"][data-event-id="diary-0"]',
    )!
    deleteNewest.focus()
    await act(async () => deleteNewest.click())
    await act(async () => deleteNewest.click())

    const nextEdit = container.querySelector<HTMLButtonElement>(
      '[data-diary-action="edit"][data-event-id="diary-1"]',
    )!
    expect(container.querySelector('[data-event-id="diary-0"]')).toBeNull()
    expect(document.activeElement).toBe(nextEdit)
  })

  it.each([
    ['diary', DiaryPage, 'data-diary-action'],
    ['message', MessagesPage, 'data-message-action'],
  ] as const)('keeps the latest %s delete confirmation for its full window and clears its timer on unmount', async (type, Page, actionAttribute) => {
    vi.useFakeTimers()
    try {
      useAppStore.setState({ events: Array.from({ length: 2 }, (_, index) => makeEvent(type, index)) })
      await act(async () => root.render(<Page />))

      const first = container.querySelector<HTMLButtonElement>(`[${actionAttribute}="delete"][data-event-id="${type}-0"]`)!
      const second = container.querySelector<HTMLButtonElement>(`[${actionAttribute}="delete"][data-event-id="${type}-1"]`)!
      await act(async () => first.click())
      await act(async () => vi.advanceTimersByTime(2_000))
      await act(async () => second.click())
      await act(async () => vi.advanceTimersByTime(1_001))

      expect(second.getAttribute('aria-label')).toBe(i18n.t('timeline.confirmDelete'))
      await act(async () => root.render(<div />))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['ko', '기록 더 보기'],
    ['ja', 'さらに表示'],
  ] as const)('localizes both progressive controls in %s and hides them for zero or one record', async (language, label) => {
    await i18n.changeLanguage(language)
    useAppStore.setState({ events: Array.from({ length: 1_000 }, (_, index) => makeEvent('diary', index)) })
    await act(async () => root.render(<DiaryPage />))
    expect(container.querySelector<HTMLButtonElement>('[data-list-load-more="diary"]')?.textContent).toContain(label)

    await act(async () => useAppStore.setState({ events: Array.from({ length: 1_000 }, (_, index) => makeEvent('message', index)) }))
    await act(async () => root.render(<MessagesPage />))

    expect(container.querySelectorAll('[data-message-entry]')).toHaveLength(48)
    expect(container.querySelector<HTMLButtonElement>('[data-list-load-more="messages"]')?.textContent).toContain(label)

    await act(async () => useAppStore.setState({ events: [makeEvent('message', 0)] }))
    expect(container.querySelectorAll('[data-message-entry]')).toHaveLength(1)
    expect(container.querySelector('[data-list-load-more="messages"]')).toBeNull()

    await act(async () => useAppStore.setState({ events: [] }))
    expect(container.querySelector('[data-list-load-more="messages"]')).toBeNull()
  })

  it('keeps reduced-motion users out of stagger animations', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'index.css'), 'utf8')
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.stagger-mount[\s\S]*?animation:\s*none/)
  })
})
