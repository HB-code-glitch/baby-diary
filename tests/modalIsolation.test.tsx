/** @vitest-environment jsdom */

import React, { act, StrictMode, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessibleFormDialog } from '../src/components/AccessibleFormDialog'
import { TimeEditModal } from '../src/components/TimeEditModal'
import i18n from '../src/i18n'

const CURRENT_AT = new Date(2026, 6, 13, 10, 30, 0).toISOString()

function keyDown(element: HTMLElement, key: string, shiftKey = false) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
}

function MixedModalHarness({
  editor,
  time,
  onEditorClose,
  onTimeClose,
}: {
  editor: boolean
  time: boolean
  onEditorClose: () => void
  onTimeClose: () => void
}) {
  const editorInputRef = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <div className="app-shell" data-app-content>
        <button type="button" data-app-action>app action</button>
      </div>
      <div className="toast-container" data-toast-sibling>
        <button type="button" data-toast-action>toast action</button>
      </div>
      <button type="button" data-update-sibling>update action</button>
      {editor && (
        <AccessibleFormDialog
          modalName="diary"
          titleId="editor-title"
          busy={false}
          initialFocusRef={editorInputRef}
          onClose={onEditorClose}
          onSubmit={() => undefined}
        >
          <h2 id="editor-title">editor</h2>
          <input ref={editorInputRef} data-editor-focus />
          <div role="alert" tabIndex={-1} data-editor-live-error>retry inside dialog</div>
          <button type="submit" data-editor-last>save</button>
        </AccessibleFormDialog>
      )}
      {time && (
        <TimeEditModal
          currentAt={CURRENT_AT}
          onConfirm={vi.fn()}
          onClose={onTimeClose}
        />
      )}
    </>
  )
}

describe('shared modal isolation', () => {
  let rootContainer: HTMLDivElement
  let outsideSibling: HTMLButtonElement
  let root: Root

  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    rootContainer = document.createElement('div')
    rootContainer.id = 'root'
    outsideSibling = document.createElement('button')
    outsideSibling.type = 'button'
    outsideSibling.dataset.outsideBodySibling = ''
    document.body.append(rootContainer, outsideSibling)
    root = createRoot(rootContainer)
    await i18n.changeLanguage('ko')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    rootContainer.remove()
    outsideSibling.remove()
    document.body.querySelectorAll('[data-modal-portal]').forEach(element => element.remove())
    await i18n.changeLanguage('ko')
  })

  it('isolates the whole app root and every body sibling while keeping live dialog content focusable', async () => {
    const onEditorClose = vi.fn()
    rootContainer.setAttribute('inert', 'pre-existing')
    rootContainer.setAttribute('aria-hidden', 'false')
    outsideSibling.setAttribute('aria-hidden', 'false')

    await act(async () => root.render(
      <MixedModalHarness
        editor
        time={false}
        onEditorClose={onEditorClose}
        onTimeClose={vi.fn()}
      />,
    ))

    const portal = document.body.querySelector<HTMLElement>('[data-modal-portal="editor"]')!
    const input = portal.querySelector<HTMLInputElement>('[data-editor-focus]')!
    const liveError = portal.querySelector<HTMLElement>('[data-editor-live-error]')!
    const last = portal.querySelector<HTMLButtonElement>('[data-editor-last]')!

    expect(portal.parentElement).toBe(document.body)
    expect(portal.hasAttribute('inert')).toBe(false)
    expect(rootContainer.getAttribute('inert')).toBe('')
    expect(rootContainer.getAttribute('aria-hidden')).toBe('true')
    expect(outsideSibling.getAttribute('inert')).toBe('')
    expect(outsideSibling.getAttribute('aria-hidden')).toBe('true')
    expect(document.activeElement).toBe(input)

    outsideSibling.focus()
    expect(document.activeElement).toBe(input)
    liveError.focus()
    expect(document.activeElement).toBe(liveError)

    await act(async () => keyDown(outsideSibling, 'Tab', true))
    expect(document.activeElement).toBe(last)
    await act(async () => keyDown(outsideSibling, 'Escape'))
    expect(onEditorClose).toHaveBeenCalledTimes(1)

    await act(async () => root.render(
      <MixedModalHarness
        editor={false}
        time={false}
        onEditorClose={onEditorClose}
        onTimeClose={vi.fn()}
      />,
    ))
    expect(rootContainer.getAttribute('inert')).toBe('pre-existing')
    expect(rootContainer.getAttribute('aria-hidden')).toBe('false')
    expect(outsideSibling.hasAttribute('inert')).toBe(false)
    expect(outsideSibling.getAttribute('aria-hidden')).toBe('false')
  })

  it('keeps the topmost mixed modal active and reactivates the lower dialog in LIFO order', async () => {
    const onEditorClose = vi.fn()
    const onTimeClose = vi.fn()
    await act(async () => root.render(
      <MixedModalHarness editor time onEditorClose={onEditorClose} onTimeClose={onTimeClose} />,
    ))

    const editorPortal = document.body.querySelector<HTMLElement>('[data-modal-portal="editor"]')!
    const timePortal = document.body.querySelector<HTMLElement>('[data-modal-portal="time"]')!
    const editorInput = editorPortal.querySelector<HTMLInputElement>('[data-editor-focus]')!
    const timeInput = timePortal.querySelector<HTMLInputElement>('[data-time-edit-input]')!

    expect(editorPortal.hasAttribute('inert')).toBe(true)
    expect(timePortal.hasAttribute('inert')).toBe(false)
    expect(Number(getComputedStyle(timePortal).zIndex)).toBeGreaterThan(Number(getComputedStyle(editorPortal).zIndex))
    expect(getComputedStyle(editorPortal).pointerEvents).toBe('none')
    expect(getComputedStyle(timePortal).pointerEvents).toBe('auto')
    expect(rootContainer.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(timeInput)

    editorInput.focus()
    expect(document.activeElement).toBe(timeInput)
    await act(async () => keyDown(outsideSibling, 'Escape'))
    expect(onTimeClose).toHaveBeenCalledTimes(1)
    expect(onEditorClose).not.toHaveBeenCalled()

    await act(async () => root.render(
      <MixedModalHarness editor time={false} onEditorClose={onEditorClose} onTimeClose={onTimeClose} />,
    ))
    expect(document.body.querySelector('[data-modal-portal="time"]')).toBeNull()
    expect(editorPortal.hasAttribute('inert')).toBe(false)
    expect(getComputedStyle(editorPortal).pointerEvents).toBe('auto')
    expect(rootContainer.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(editorInput)

    await act(async () => keyDown(outsideSibling, 'Escape'))
    expect(onEditorClose).toHaveBeenCalledTimes(1)
    await act(async () => root.render(
      <MixedModalHarness editor={false} time={false} onEditorClose={onEditorClose} onTimeClose={onTimeClose} />,
    ))
    expect(rootContainer.hasAttribute('inert')).toBe(false)
    expect(outsideSibling.hasAttribute('inert')).toBe(false)
  })

  it('keeps visual, pointer, focus, and Escape order aligned when Editor opens after Time', async () => {
    const onEditorClose = vi.fn()
    const onTimeClose = vi.fn()
    await act(async () => root.render(
      <MixedModalHarness editor={false} time onEditorClose={onEditorClose} onTimeClose={onTimeClose} />,
    ))
    const timePortal = document.body.querySelector<HTMLElement>('[data-modal-portal="time"]')!
    const timeInput = timePortal.querySelector<HTMLInputElement>('[data-time-edit-input]')!
    expect(getComputedStyle(timePortal).pointerEvents).toBe('auto')

    await act(async () => root.render(
      <MixedModalHarness editor time onEditorClose={onEditorClose} onTimeClose={onTimeClose} />,
    ))
    const editorPortal = document.body.querySelector<HTMLElement>('[data-modal-portal="editor"]')!
    const editorInput = editorPortal.querySelector<HTMLInputElement>('[data-editor-focus]')!
    expect(Number(getComputedStyle(editorPortal).zIndex)).toBeGreaterThan(Number(getComputedStyle(timePortal).zIndex))
    expect(getComputedStyle(editorPortal).pointerEvents).toBe('auto')
    expect(getComputedStyle(timePortal).pointerEvents).toBe('none')
    expect(editorPortal.hasAttribute('inert')).toBe(false)
    expect(timePortal.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(editorInput)

    timeInput.focus()
    expect(document.activeElement).toBe(editorInput)
    await act(async () => keyDown(outsideSibling, 'Escape'))
    expect(onEditorClose).toHaveBeenCalledTimes(1)
    expect(onTimeClose).not.toHaveBeenCalled()

    await act(async () => root.render(
      <MixedModalHarness editor={false} time onEditorClose={onEditorClose} onTimeClose={onTimeClose} />,
    ))
    expect(document.body.querySelector('[data-modal-portal="editor"]')).toBeNull()
    expect(timePortal.hasAttribute('inert')).toBe(false)
    expect(getComputedStyle(timePortal).pointerEvents).toBe('auto')
    expect(document.activeElement).toBe(timeInput)
    await act(async () => keyDown(outsideSibling, 'Escape'))
    expect(onTimeClose).toHaveBeenCalledTimes(1)
  })

  it('does not leak portal hosts, listeners, or inert leases through StrictMode replay', async () => {
    await act(async () => root.render(
      <StrictMode>
        <MixedModalHarness editor time={false} onEditorClose={vi.fn()} onTimeClose={vi.fn()} />
      </StrictMode>,
    ))
    expect(document.body.querySelectorAll('[data-modal-portal="editor"]')).toHaveLength(1)
    expect(rootContainer.hasAttribute('inert')).toBe(true)

    await act(async () => root.render(
      <StrictMode>
        <MixedModalHarness editor={false} time={false} onEditorClose={vi.fn()} onTimeClose={vi.fn()} />
      </StrictMode>,
    ))
    expect(document.body.querySelectorAll('[data-modal-portal]')).toHaveLength(0)
    expect(rootContainer.hasAttribute('inert')).toBe(false)
    expect(rootContainer.hasAttribute('aria-hidden')).toBe(false)
    outsideSibling.focus()
    expect(document.activeElement).toBe(outsideSibling)
  })
})
