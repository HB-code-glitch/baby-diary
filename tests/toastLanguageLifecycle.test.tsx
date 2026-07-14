/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToastProvider, useToast } from '../src/components/Toast'
import i18n from '../src/i18n'

function Harness() {
  const { showToast } = useToast()
  return (
    <button
      data-show-toast
      type="button"
      onClick={() => showToast({ message: '한국어 저장 완료' })}
    >
      show
    </button>
  )
}

describe('ToastProvider language lifecycle', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await i18n.changeLanguage('ko')
    await act(async () => root.render(
      <React.StrictMode>
        <ToastProvider><Harness /></ToastProvider>
      </React.StrictMode>,
    ))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    await i18n.changeLanguage('ko')
  })

  it('removes already-rendered old-language strings when the language changes', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[data-show-toast]')!.click())
    expect(document.body.querySelector('.toast')?.textContent).toContain('한국어 저장 완료')

    await act(async () => i18n.changeLanguage('ja'))

    expect(document.body.querySelector('.toast')).toBeNull()
  })
})
