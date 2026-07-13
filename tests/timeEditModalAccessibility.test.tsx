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
    <>
      <button data-modal-trigger type="button" onClick={() => setOpen(true)}>open</button>
      {open && (
        <TimeEditModal
          currentAt={CURRENT_AT}
          onConfirm={onConfirm}
          onClose={() => setOpen(false)}
        />
      )}
    </>
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
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const input = container.querySelector<HTMLInputElement>('[data-time-edit-input]')!
    const label = container.querySelector<HTMLLabelElement>('label[for]')!

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('시간 수정')
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBeTruthy()
    expect(label.htmlFor).toBe(input.id)
    expect(input.name).toBe('recordedAt')
    expect(input.autocomplete).toBe('off')
    expect(document.activeElement).toBe(input)
    expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('timeEdit.close')}"]`)).not.toBeNull()
    expect(input.classList.contains('time-edit-input')).toBe(true)
    expect(Array.from(dialog.querySelectorAll('button')).every(button => button.classList.contains('time-edit-control'))).toBe(true)
  })

  it('traps Tab within the dialog and restores the trigger after Escape', async () => {
    const trigger = await open()
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const close = container.querySelector<HTMLButtonElement>('[data-time-edit-action="close"]')!
    const confirm = container.querySelector<HTMLButtonElement>('[data-time-edit-action="confirm"]')!

    confirm.focus()
    await act(async () => keyDown(dialog, 'Tab'))
    expect(document.activeElement).toBe(close)
    close.focus()
    await act(async () => keyDown(dialog, 'Tab', true))
    expect(document.activeElement).toBe(confirm)

    await act(async () => keyDown(dialog, 'Escape'))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('submits with Enter once and disables every mutable control while awaiting', async () => {
    let resolve!: () => void
    const pending = new Promise<void>(done => { resolve = done })
    const onConfirm = vi.fn(() => pending)
    await open(onConfirm)
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const input = container.querySelector<HTMLInputElement>('[data-time-edit-input]')!

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
    const confirm = container.querySelector<HTMLButtonElement>('[data-time-edit-action="confirm"]')!
    await act(async () => confirm.click())

    expect(onConfirm).toHaveBeenCalledTimes(1)
    const input = container.querySelector<HTMLInputElement>('[data-time-edit-input]')!
    expect(input.disabled).toBe(false)
    expect(confirm.disabled).toBe(false)
    expect(document.activeElement).toBe(input)
  })
})
