/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../src/i18n'
import { FeverModal } from '../src/components/FeverModal'
import * as homeModule from '../src/pages/HomePage'

const anchor = {
  left: 100,
  right: 140,
  top: 100,
  bottom: 140,
  width: 40,
  height: 40,
  x: 100,
  y: 100,
  toJSON: () => ({}),
} as DOMRect

describe('temperature safety DOM behavior', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('ko')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.style.overflow = ''
  })

  it('passes selected red flags from the progressive disclosure to onConfirm', async () => {
    expect(homeModule).toHaveProperty('TempPopover')
    const TempPopover = (homeModule as any).TempPopover as React.ComponentType<any>
    const onConfirm = vi.fn()

    await act(async () => {
      root.render(
        <TempPopover
          anchor={anchor}
          ageDays={null}
          defaultValue={36.8}
          onClose={() => undefined}
          onConfirm={onConfirm}
        />,
      )
    })

    const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(disclosure.textContent).toContain('위험 신호 확인')
    await act(async () => disclosure.click())

    const checkbox = container.querySelector<HTMLInputElement>('input[value="breathing_difficulty"]')!
    expect(checkbox).not.toBeNull()
    await act(async () => checkbox.click())
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onConfirm).toHaveBeenCalledWith(36.8, ['breathing_difficulty'])
    expect(container.textContent).toContain('하나라도')
  })

  it('focuses and traps the dialog, closes on Escape, restores the opener, and unlocks body scroll', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'temperature opener'
    document.body.appendChild(opener)
    const transientInput = document.createElement('input')
    document.body.appendChild(transientInput)
    transientInput.focus()
    transientInput.remove()
    const onConfirm = vi.fn()

    await act(async () => {
      root.render(
        <FeverModal
          celsius={38}
          level="emergency"
          ageDays={20}
          lang="ko"
          returnFocusTo={opener}
          onConfirm={onConfirm}
        />,
      )
    })

    const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect(document.activeElement).toBe(dialog)
    expect(document.body.style.overflow).toBe('hidden')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).not.toBeNull()
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)).not.toBeNull()

    const focusable = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
    focusable.at(-1)!.focus()
    await act(async () => {
      focusable.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(document.activeElement).toBe(focusable[0])

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onConfirm).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    expect(document.activeElement).toBe(opener)
    expect(document.body.style.overflow).toBe('')
    opener.remove()

    root = createRoot(container)
  })
})
