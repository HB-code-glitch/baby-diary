/** @vitest-environment jsdom */

import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../src/i18n'
import { TimeEditModal } from '../src/components/TimeEditModal'

const CURRENT_AT = new Date(2026, 6, 13, 10, 30, 0).toISOString()

function Harness({ onConfirm }: { onConfirm: (value: string) => Promise<void> | void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="app-shell" data-test-app-shell>
      <button data-modal-trigger type="button" onClick={() => setOpen(true)}>open</button>
      {open && (
        <TimeEditModal
          currentAt={CURRENT_AT}
          onConfirm={onConfirm}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function ModalCountHarness({ count }: { count: number }) {
  return (
    <div className="app-shell" data-test-app-shell>
      {Array.from({ length: count }, (_, index) => (
        <TimeEditModal
          key={index}
          currentAt={CURRENT_AT}
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        />
      ))}
    </div>
  )
}

function keyDown(element: HTMLElement, key: string, shiftKey = false) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
}

describe('TimeEditModal accessibility and async safety', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await i18n.changeLanguage('ko')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    await i18n.changeLanguage('ko')
  })

  async function open(onConfirm: (value: string) => Promise<void> | void = vi.fn()) {
    await act(async () => root.render(<Harness onConfirm={onConfirm} />))
    const trigger = container.querySelector<HTMLButtonElement>('[data-modal-trigger]')!
    trigger.focus()
    await act(async () => trigger.click())
    return trigger
  }

  it('connects dialog name, description, and label and initially focuses the date input', async () => {
    await open()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const input = document.body.querySelector<HTMLInputElement>('[data-time-edit-input]')!
    const label = document.body.querySelector<HTMLLabelElement>('label[for]')!

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('시간 수정')
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBeTruthy()
    expect(label.htmlFor).toBe(input.id)
    expect(input.name).toBe('recordedAt')
    expect(input.autocomplete).toBe('off')
    expect(document.activeElement).toBe(input)
    expect(document.body.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('timeEdit.close')}"]`)).not.toBeNull()
    expect(input.classList.contains('time-edit-input')).toBe(true)
    expect(Array.from(dialog.querySelectorAll('button')).every(button => button.classList.contains('time-edit-control'))).toBe(true)
  })

  it('traps Tab within the dialog and restores the trigger after Escape', async () => {
    const trigger = await open()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const close = document.body.querySelector<HTMLButtonElement>('[data-time-edit-action="close"]')!
    const confirm = document.body.querySelector<HTMLButtonElement>('[data-time-edit-action="confirm"]')!

    confirm.focus()
    await act(async () => keyDown(dialog, 'Tab'))
    expect(document.activeElement).toBe(close)
    close.focus()
    await act(async () => keyDown(dialog, 'Tab', true))
    expect(document.activeElement).toBe(confirm)

    await act(async () => keyDown(dialog, 'Escape'))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('submits with Enter once and disables every mutable control while awaiting', async () => {
    let resolve!: () => void
    const pending = new Promise<void>(done => { resolve = done })
    const onConfirm = vi.fn(() => pending)
    await open(onConfirm)
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const input = document.body.querySelector<HTMLInputElement>('[data-time-edit-input]')!

    await act(async () => {
      keyDown(input, 'Enter')
      keyDown(input, 'Enter')
      await Promise.resolve()
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')).every(control => control.disabled)).toBe(true)
    expect(document.activeElement).toBe(dialog)
    await act(async () => keyDown(dialog, 'Tab'))
    expect(document.activeElement).toBe(dialog)

    await act(async () => {
      resolve()
      await pending
    })
  })

  it('re-enables retry controls after an async failure under React StrictMode', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('save failed'))
    await act(async () => root.render(
      <React.StrictMode>
        <Harness onConfirm={onConfirm} />
      </React.StrictMode>,
    ))
    const trigger = container.querySelector<HTMLButtonElement>('[data-modal-trigger]')!
    await act(async () => trigger.click())
    const confirm = document.body.querySelector<HTMLButtonElement>('[data-time-edit-action="confirm"]')!
    await act(async () => confirm.click())

    expect(onConfirm).toHaveBeenCalledTimes(1)
    const input = document.body.querySelector<HTMLInputElement>('[data-time-edit-input]')!
    expect(input.disabled).toBe(false)
    expect(confirm.disabled).toBe(false)
    expect(document.activeElement).toBe(input)
  })

  it('portals the viewport overlay to body and makes the app shell inert until close', async () => {
    const trigger = await open()
    const appShell = container.querySelector<HTMLElement>('[data-test-app-shell]')!
    const backdrop = document.body.querySelector<HTMLElement>('[data-time-edit-modal]')!

    expect(backdrop.closest('[data-modal-portal="time"]')?.parentElement).toBe(document.body)
    expect(appShell.closest('[inert]')).not.toBeNull()
    expect(appShell.closest('[aria-hidden="true"]')).not.toBeNull()

    await act(async () => keyDown(backdrop.querySelector<HTMLElement>('[role="dialog"]')!, 'Escape'))

    expect(document.body.querySelector('[data-time-edit-modal]')).toBeNull()
    expect(appShell.closest('[inert]')).toBeNull()
    expect(appShell.closest('[aria-hidden="true"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('restores pre-existing inert and aria-hidden values exactly', async () => {
    await act(async () => root.render(<Harness onConfirm={vi.fn()} />))
    container.setAttribute('inert', 'pre-existing')
    container.setAttribute('aria-hidden', 'false')
    const trigger = container.querySelector<HTMLButtonElement>('[data-modal-trigger]')!

    await act(async () => trigger.click())
    expect(container.getAttribute('inert')).toBe('')
    expect(container.getAttribute('aria-hidden')).toBe('true')

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => keyDown(dialog, 'Escape'))
    expect(container.getAttribute('inert')).toBe('pre-existing')
    expect(container.getAttribute('aria-hidden')).toBe('false')
  })

  it('keeps the app shell inert until the final concurrent modal unmounts', async () => {
    await act(async () => root.render(<ModalCountHarness count={2} />))
    const appShell = container.querySelector<HTMLElement>('[data-test-app-shell]')!
    expect(document.body.querySelectorAll('[data-time-edit-modal]')).toHaveLength(2)
    expect(appShell.closest('[inert]')).not.toBeNull()

    await act(async () => root.render(<ModalCountHarness count={1} />))
    expect(document.body.querySelectorAll('[data-time-edit-modal]')).toHaveLength(1)
    expect(appShell.closest('[inert]')).not.toBeNull()
    expect(appShell.closest('[aria-hidden="true"]')).not.toBeNull()

    await act(async () => root.render(<ModalCountHarness count={0} />))
    expect(document.body.querySelectorAll('[data-time-edit-modal]')).toHaveLength(0)
    expect(appShell.closest('[inert]')).toBeNull()
    expect(appShell.closest('[aria-hidden="true"]')).toBeNull()
  })
})
