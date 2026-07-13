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
const originalStore = useAppStore.getState()

function makeEvent(type: 'diary' | 'message'): DiaryEvent {
  const timestamp = '2026-07-13T10:00:00.000Z'
  return {
    id: `${type}-event`,
    mutationId: '11111111-1111-4111-8111-111111111111',
    type,
    at: timestamp,
    data: type === 'diary'
      ? ({ title: '기존 제목', text: '보존할 일기 내용' } satisfies DiaryData)
      : ({ text: '보존할 편지 내용' } satisfies MessageData),
    author: { uid: 'tester', name: '보호자', role: 'mom' },
    createdAt: timestamp,
    updatedAt: timestamp,
    rev: 1,
    deleted: false,
  }
}

function keyDown(element: HTMLElement, key: string, shiftKey = false) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
}

function changeTextarea(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Diary and Messages editor dialog accessibility', () => {
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

  async function renderDiary(
    editEvent = vi.fn(async (event: DiaryEvent) => event),
    strict = false,
  ) {
    useAppStore.setState({ events: [makeEvent('diary')], editEvent })
    const page = (
      <div className="app-shell" data-test-app-shell>
        <DiaryPage />
      </div>
    )
    await act(async () => root.render(strict ? <React.StrictMode>{page}</React.StrictMode> : page))
    const trigger = container.querySelector<HTMLButtonElement>('[data-diary-action="edit"]')!
    trigger.focus()
    await act(async () => trigger.click())
    return { trigger, editEvent }
  }

  it('portals the Diary editor, names and labels it, traps focus, and restores its trigger on Escape', async () => {
    const { trigger } = await renderDiary()
    const shell = container.querySelector<HTMLElement>('[data-test-app-shell]')!
    const dialog = document.body.querySelector<HTMLFormElement>('[data-editor-modal="diary"]')!
    const text = document.body.querySelector<HTMLTextAreaElement>('[data-editor-input="diary-text"]')!
    const title = document.body.querySelector<HTMLInputElement>('[data-editor-input="diary-title"]')!
    const close = dialog.querySelector<HTMLButtonElement>('[data-editor-action="close"]')!
    const save = dialog.querySelector<HTMLButtonElement>('[data-editor-action="save"]')!

    expect(dialog.closest('[data-modal-portal="editor"]')?.parentElement).toBe(document.body)
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('일기 수정')
    expect(document.body.querySelector<HTMLLabelElement>(`label[for="${title.id}"]`)).not.toBeNull()
    expect(document.body.querySelector<HTMLLabelElement>(`label[for="${text.id}"]`)).not.toBeNull()
    expect(document.activeElement).toBe(text)
    expect(shell.closest('[inert]')).not.toBeNull()
    expect(shell.closest('[aria-hidden="true"]')).not.toBeNull()

    save.focus()
    await act(async () => keyDown(dialog, 'Tab'))
    expect(document.activeElement).toBe(close)
    await act(async () => keyDown(dialog, 'Tab', true))
    expect(document.activeElement).toBe(save)

    // Programmatic focus can still escape an inert subtree in some engines.
    // The dialog must pull either tab direction back to the correct edge.
    trigger.focus()
    expect(document.activeElement).toBe(text)
    await act(async () => keyDown(trigger, 'Tab'))
    expect(document.activeElement).toBe(close)
    trigger.focus()
    expect(document.activeElement).toBe(text)
    await act(async () => keyDown(trigger, 'Tab', true))
    expect(document.activeElement).toBe(save)

    await act(async () => keyDown(dialog, 'Escape'))
    expect(document.body.querySelector('[data-editor-modal="diary"]')).toBeNull()
    expect(shell.closest('[inert]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('blocks duplicate Diary submits while pending and closes only after durable success', async () => {
    let resolve!: (event: DiaryEvent) => void
    const pending = new Promise<DiaryEvent>(done => { resolve = done })
    const editEvent = vi.fn(() => pending)
    await renderDiary(editEvent)
    const dialog = document.body.querySelector<HTMLFormElement>('[data-editor-modal="diary"]')!

    await act(async () => {
      dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(editEvent).toHaveBeenCalledTimes(1)
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect(Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button')).every(control => control.disabled)).toBe(true)

    await act(async () => {
      resolve(makeEvent('diary'))
      await pending
    })
    expect(document.body.querySelector('[data-editor-modal="diary"]')).toBeNull()
  })

  it('keeps Diary text and retry controls after an async save failure', async () => {
    const editEvent = vi.fn().mockRejectedValue(new Error('disk full'))
    await renderDiary(editEvent, true)
    const dialog = document.body.querySelector<HTMLFormElement>('[data-editor-modal="diary"]')!
    const text = dialog.querySelector<HTMLTextAreaElement>('[data-editor-input="diary-text"]')!
    await act(async () => changeTextarea(text, '실패해도 남아야 하는 내용'))

    await act(async () => {
      dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(document.body.querySelector('[data-editor-modal="diary"]')).toBe(dialog)
    expect(text.value).toBe('실패해도 남아야 하는 내용')
    expect(Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button')).every(control => !control.disabled)).toBe(true)
    expect(document.activeElement).toBe(text)
    const alert = dialog.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toBe(i18n.t('toast.saveFailed'))
    expect(alert.getAttribute('aria-live')).toBe('assertive')
    expect(text.getAttribute('aria-describedby')).toBe(alert.id)

    await act(async () => changeTextarea(text, '다시 입력한 내용'))
    expect(dialog.querySelector('[role="alert"]')).toBeNull()
    expect(text.hasAttribute('aria-describedby')).toBe(false)
  })

  it('announces a Japanese Message failure inside StrictMode and clears it after retry success and reopen', async () => {
    await i18n.changeLanguage('ja')
    const message = makeEvent('message')
    const editEvent = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(message)
    useAppStore.setState({ events: [message], editEvent })
    const page = (
      <div className="app-shell" data-test-app-shell>
        <MessagesPage />
      </div>
    )
    await act(async () => root.render(<React.StrictMode>{page}</React.StrictMode>))
    const trigger = container.querySelector<HTMLButtonElement>('[data-message-action="edit"]')!
    await act(async () => trigger.click())
    const dialog = document.body.querySelector<HTMLFormElement>('[data-editor-modal="messages"]')!
    const text = dialog.querySelector<HTMLTextAreaElement>('[data-editor-input="message-text"]')!
    const preserved = text.value

    await act(async () => {
      dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    const alert = dialog.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toBe(i18n.t('toast.saveFailed'))
    expect(text.value).toBe(preserved)
    expect(text.getAttribute('aria-describedby')).toBe(alert.id)
    expect(document.activeElement).toBe(text)

    await act(async () => {
      dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-editor-modal="messages"]')).toBeNull()
    expect(editEvent).toHaveBeenCalledTimes(2)

    await act(async () => trigger.click())
    const reopened = document.body.querySelector<HTMLFormElement>('[data-editor-modal="messages"]')!
    expect(reopened.querySelector('[role="alert"]')).toBeNull()
    expect(reopened.querySelector('[data-editor-input="message-text"]')?.hasAttribute('aria-describedby')).toBe(false)
  })

  it('applies the same portal and localized dialog contract to Messages in Japanese', async () => {
    await i18n.changeLanguage('ja')
    useAppStore.setState({ events: [makeEvent('message')] })
    await act(async () => root.render(
      <div className="app-shell" data-test-app-shell>
        <MessagesPage />
      </div>,
    ))
    const trigger = container.querySelector<HTMLButtonElement>('[data-message-action="edit"]')!
    trigger.focus()
    await act(async () => trigger.click())

    const dialog = document.body.querySelector<HTMLFormElement>('[data-editor-modal="messages"]')!
    const text = dialog.querySelector<HTMLTextAreaElement>('[data-editor-input="message-text"]')!
    expect(dialog.closest('[data-modal-portal="editor"]')?.parentElement).toBe(document.body)
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('メッセージを編集')
    expect(document.body.querySelector<HTMLLabelElement>(`label[for="${text.id}"]`)).not.toBeNull()
    expect(dialog.querySelector<HTMLButtonElement>('[data-editor-action="close"]')?.getAttribute('aria-label')).toBe(i18n.t('timeEdit.close'))
    expect(document.activeElement).toBe(text)
  })

  it('gives every editor control a 40px target and disables motion when requested', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'index.css'), 'utf8')
    expect(css).toMatch(/\.editor-modal-control\s*\{[\s\S]*?min-height:\s*40px/)
    expect(css).toMatch(/\.editor-modal-dialog\s*\{[\s\S]*?overscroll-behavior:\s*contain/)
    expect(css).not.toMatch(/\.editor-modal-overlay\s*\{[^}]*z-index:/)
    expect(css).not.toMatch(/\.time-edit-backdrop\s*\{[^}]*z-index:/)
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.editor-modal-dialog[\s\S]*?animation:\s*none/)
  })
})
