/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiaryEvent } from '../shared/types'
import { EventTimeline } from '../src/components/EventTimeline'
import i18n from '../src/i18n'
import { formatTime, useAppStore } from '../src/store/useAppStore'

const EVENT: DiaryEvent = {
  id: 'pee-event',
  type: 'pee',
  at: new Date(2026, 6, 13, 10, 30, 0).toISOString(),
  data: {},
  author: { uid: 'test', name: 'Tester', role: 'mom' },
  createdAt: new Date(2026, 6, 13, 10, 30, 0).toISOString(),
  updatedAt: new Date(2026, 6, 13, 10, 30, 0).toISOString(),
  rev: 1,
  deleted: false,
}

describe('EventTimeline interactions and accessibility', () => {
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
    editEvent = vi.fn().mockResolvedValue(EVENT)
    softDeleteEvent = vi.fn().mockResolvedValue({ ...EVENT, deleted: true })
    useAppStore.setState({ editEvent, softDeleteEvent })
    await i18n.changeLanguage('ko')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState({ editEvent: originalEditEvent, softDeleteEvent: originalSoftDeleteEvent })
    await i18n.changeLanguage('ko')
  })

  it('labels 40px actions with event and time and uses a focusable inline delete confirmation', async () => {
    await act(async () => root.render(<EventTimeline events={[EVENT]} />))
    const time = formatTime(EVENT.at)
    const editButton = container.querySelector<HTMLButtonElement>(`button[aria-label="소변 ${time} 시간 수정"]`)
    const deleteButton = container.querySelector<HTMLButtonElement>(`button[aria-label="소변 ${time} 삭제"]`)

    expect(editButton).not.toBeNull()
    expect(deleteButton).not.toBeNull()
    expect(editButton?.classList.contains('timeline-action-button')).toBe(true)
    expect(deleteButton?.classList.contains('timeline-action-button')).toBe(true)

    await act(async () => deleteButton!.click())
    const confirmation = container.querySelector<HTMLElement>('.timeline-delete-confirm')!
    expect(confirmation.textContent).toContain('삭제할까요?')
    const cancel = Array.from(confirmation.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '취소')!
    expect(document.activeElement).toBe(cancel)

    await act(async () => {
      confirmation.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('.timeline-delete-confirm')).toBeNull()
    const restoredDeleteButton = container.querySelector<HTMLButtonElement>(`button[aria-label="소변 ${time} 삭제"]`)!
    expect(document.activeElement).toBe(restoredDeleteButton)

    await act(async () => restoredDeleteButton.click())
    const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>('.timeline-delete-confirm button'))
      .find(button => button.textContent?.trim() === '삭제')!
    await act(async () => confirm.click())
    expect(softDeleteEvent).toHaveBeenCalledTimes(1)
    expect(softDeleteEvent).toHaveBeenCalledWith(EVENT)
  })

  it('bounds every timeline entrance delay with the shared stagger contract', async () => {
    const events = Array.from({ length: 60 }, (_, index) => ({
      ...EVENT,
      id: `event-${index}`,
      at: new Date(Date.parse(EVENT.at) - index * 60_000).toISOString(),
    }))
    await act(async () => root.render(<EventTimeline events={events} />))

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.timeline-item'))
    expect(rows).toHaveLength(60)
    expect(rows.every(row => row.classList.contains('bounded-stagger'))).toBe(true)
    expect(rows.at(-1)?.style.getPropertyValue('--stagger-delay')).toBe('336ms')
    expect(rows.every(row => !row.style.getPropertyValue('--i'))).toBe(true)
  })

  it('keeps the time edit modal wired to the existing store edit call', async () => {
    await act(async () => root.render(<EventTimeline events={[EVENT]} />))
    const time = formatTime(EVENT.at)
    await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="소변 ${time} 시간 수정"]`)!.click())

    const input = document.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '2026-07-13T11:45')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '확인')!
    await act(async () => confirm.click())

    expect(editEvent).toHaveBeenCalledTimes(1)
    expect(editEvent.mock.calls[0][0]).toEqual(EVENT)
    expect(editEvent.mock.calls[0][1]).toEqual({ at: new Date('2026-07-13T11:45').toISOString() })
  })

  it('restores focus to the original delete action when soft delete fails', async () => {
    softDeleteEvent.mockRejectedValueOnce(new Error('delete failed'))
    await act(async () => root.render(<EventTimeline events={[EVENT]} />))
    const time = formatTime(EVENT.at)
    const deleteButton = container.querySelector<HTMLButtonElement>(`button[aria-label="소변 ${time} 삭제"]`)!

    await act(async () => deleteButton.click())
    const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>('.timeline-delete-confirm button'))
      .find(button => button.textContent?.trim() === '삭제')!
    await act(async () => confirm.click())

    expect(softDeleteEvent).toHaveBeenCalledWith(EVENT)
    expect(container.querySelector('.timeline-delete-confirm')).toBeNull()
    const restoredDeleteButton = container.querySelector<HTMLButtonElement>(`button[aria-label="소변 ${time} 삭제"]`)!
    expect(document.activeElement).toBe(restoredDeleteButton)
  })
})
