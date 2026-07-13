/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiaryEvent } from '../shared/types'
import { EventTimeline } from '../src/components/EventTimeline'
import { ToastProvider } from '../src/components/Toast'
import i18n from '../src/i18n'
import { useAppStore } from '../src/store/useAppStore'

function event(id: string, hour: number): DiaryEvent {
  const at = new Date(2026, 6, 13, hour, 30, 0).toISOString()
  return {
    id,
    type: 'pee',
    at,
    data: {},
    author: { uid: 'test', name: 'Tester', role: 'mom' },
    createdAt: at,
    updatedAt: at,
    rev: 1,
    deleted: false,
  }
}

const FIRST = event('first', 10)
const SECOND = event('second', 11)

describe('EventTimeline focus recovery and live feedback', () => {
  let container: HTMLDivElement
  let root: Root
  let editEvent: ReturnType<typeof vi.fn>
  let softDeleteEvent: ReturnType<typeof vi.fn>
  const originalEditEvent = useAppStore.getState().editEvent
  const originalSoftDeleteEvent = useAppStore.getState().softDeleteEvent

  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    editEvent = vi.fn().mockResolvedValue(FIRST)
    softDeleteEvent = vi.fn().mockResolvedValue({ ...FIRST, deleted: true })
    useAppStore.setState({ editEvent, softDeleteEvent })
    await i18n.changeLanguage('ko')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState({ editEvent: originalEditEvent, softDeleteEvent: originalSoftDeleteEvent })
    await i18n.changeLanguage('ko')
  })

  async function render(events: readonly DiaryEvent[]) {
    await act(async () => root.render(
      <ToastProvider>
        <EventTimeline events={events} />
      </ToastProvider>,
    ))
  }

  async function confirmDelete(id: string) {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-event-id="${id}"] [data-event-action="delete"]`)!.click())
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-event-id="${id}"] [data-event-action="confirm-delete"]`)!.click())
  }

  it('moves focus to the next event action after the deleted row disappears and announces one status', async () => {
    await render([FIRST, SECOND])
    await confirmDelete(FIRST.id)
    await render([SECOND])

    expect(document.activeElement).toBe(container.querySelector(`[data-event-id="${SECOND.id}"] [data-event-action="edit"]`))
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(container.querySelector('[role="status"]')?.textContent).toContain('삭제')
    expect(container.querySelector('.toast-container')?.hasAttribute('aria-live')).toBe(false)
  })

  it('focuses the persistent timeline region when the final row disappears', async () => {
    await render([FIRST])
    await confirmDelete(FIRST.id)
    await render([])

    expect(document.activeElement).toBe(container.querySelector('[data-timeline-region]'))
  })

  it('focuses the first available action when the visible list changes after deletion', async () => {
    await render([FIRST])
    await confirmDelete(FIRST.id)
    await render([SECOND])

    expect(document.activeElement).toBe(container.querySelector(`[data-event-id="${SECOND.id}"] [data-event-action="edit"]`))
  })

  it('restores the delete action and announces an alert when deletion fails', async () => {
    softDeleteEvent.mockRejectedValueOnce(new Error('delete failed'))
    await render([FIRST])
    await confirmDelete(FIRST.id)

    expect(document.activeElement).toBe(container.querySelector(`[data-event-id="${FIRST.id}"] [data-event-action="delete"]`))
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('삭제에 실패')
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(0)
  })

  it('keeps the editor open and re-enabled when the asynchronous edit fails', async () => {
    editEvent.mockRejectedValueOnce(new Error('edit failed'))
    await render([FIRST])
    await act(async () => container.querySelector<HTMLButtonElement>('[data-event-action="edit"]')!.click())
    const confirm = container.querySelector<HTMLButtonElement>('[data-time-edit-action="confirm"]')!
    await act(async () => confirm.click())

    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.querySelector<HTMLInputElement>('[data-time-edit-input]')?.disabled).toBe(false)
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
  })

  it('restores the edit trigger after its event revision updates while the dialog is open', async () => {
    await render([FIRST])
    const trigger = container.querySelector<HTMLButtonElement>('[data-event-action="edit"]')!
    trigger.focus()
    await act(async () => trigger.click())

    await render([{ ...FIRST, rev: FIRST.rev + 1 }])
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    expect(document.activeElement).toBe(container.querySelector('[data-event-action="edit"]'))
  })

  it('focuses a remaining action when a successful date edit removes the row', async () => {
    await render([FIRST, SECOND])
    const trigger = container.querySelector<HTMLButtonElement>(`[data-event-id="${FIRST.id}"] [data-event-action="edit"]`)!
    trigger.focus()
    await act(async () => trigger.click())

    await render([SECOND])
    await act(async () => container.querySelector<HTMLButtonElement>('[data-time-edit-action="confirm"]')!.click())

    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector(`[data-event-id="${SECOND.id}"] [data-event-action="edit"]`))
  })
})
