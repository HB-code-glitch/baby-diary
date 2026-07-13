/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../src/i18n'
import ko from '../src/i18n/ko.json'
import ja from '../src/i18n/ja.json'

const sync = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  status: { status: 'signed-out', detail: 'not signed in', pendingCount: 0 },
}))

const appStore = vi.hoisted(() => ({
  settings: {
    baby: { name: '아기', birthdate: '2026-01-01' },
    profile: { uid: 'same-user', name: '보호자', role: 'mom' as const },
    firebase: null,
    familyId: '',
    language: 'ko' as const,
  },
  saveSettings: vi.fn(async () => undefined),
}))

vi.mock('../src/sync/useSync', () => ({
  useSyncStatus: () => sync.status,
  restartSync: vi.fn(),
  signIn: sync.signIn,
  signUp: sync.signUp,
  signOutSync: vi.fn(),
  createFamily: vi.fn(),
  joinFamily: vi.fn(),
  DETAIL_FAMILY_GONE: 'family-gone',
}))

vi.mock('../src/store/useAppStore', () => ({
  useAppStore: () => appStore,
}))

import { SyncSettingsSlot } from '../src/components/SyncSettingsSlot'

function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('keep logged in UI', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    sync.signIn.mockResolvedValue({ uid: 'same-user' })
    sync.signUp.mockResolvedValue({ uid: 'same-user' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await i18n.changeLanguage('ko')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps Korean and Japanese label/help keys in parity', () => {
    expect(ko.sync.keepLoggedIn).toBe('로그인 상태 유지')
    expect(ja.sync.keepLoggedIn).toBe('ログイン状態を保持する')
    expect(ko.sync.keepLoggedInHelp).toBeTruthy()
    expect(ja.sync.keepLoggedInHelp).toBeTruthy()
    expect(Object.keys(ko.sync).sort()).toEqual(Object.keys(ja.sync).sort())
  })

  it.each([
    ['ko', '로그인 상태 유지'],
    ['ja', 'ログイン状態を保持する'],
  ] as const)('renders a checked, accessible option in %s', async (language, label) => {
    await i18n.changeLanguage(language)
    await act(async () => root.render(<SyncSettingsSlot />))

    const checkbox = container.querySelector<HTMLInputElement>('input[name="keepLoggedIn"]')
    expect(checkbox).not.toBeNull()
    expect(checkbox?.checked).toBe(true)
    expect(container.textContent).toContain(label)
    const helpId = checkbox?.getAttribute('aria-describedby')
    expect(helpId).toBeTruthy()
    expect(document.getElementById(helpId!)?.textContent?.trim()).toBeTruthy()
  })

  it('passes the unchecked choice to sign-in', async () => {
    await act(async () => root.render(<SyncSettingsSlot />))
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!
    const checkbox = container.querySelector<HTMLInputElement>('input[name="keepLoggedIn"]')!

    await act(async () => {
      enter(email, 'parent@example.test')
      enter(password, 'secret1')
      checkbox.click()
    })
    expect(checkbox.checked).toBe(false)

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(sync.signIn).toHaveBeenCalledWith('parent@example.test', 'secret1', false)
    expect(sync.signUp).not.toHaveBeenCalled()
  })

  it('keeps the default checked choice when switching to sign-up', async () => {
    await act(async () => root.render(<SyncSettingsSlot />))
    const switchButton = Array.from(container.querySelectorAll('button')).at(-1)!
    await act(async () => switchButton.click())

    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      enter(email, 'new-parent@example.test')
      enter(password, 'secret1')
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(sync.signUp).toHaveBeenCalledWith('new-parent@example.test', 'secret1', true)
    expect(sync.signIn).not.toHaveBeenCalled()
  })

  it('shows a persistence failure instead of treating it as a successful login', async () => {
    sync.signIn.mockRejectedValueOnce(new Error('persistence unavailable'))
    await act(async () => root.render(<SyncSettingsSlot />))
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!

    await act(async () => {
      enter(email, 'parent@example.test')
      enter(password, 'secret1')
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(container.textContent).toContain('persistence unavailable')
    expect(appStore.saveSettings).not.toHaveBeenCalled()
  })
})
