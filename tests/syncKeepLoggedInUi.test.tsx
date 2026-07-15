/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../src/i18n'
import ko from '../src/i18n/ko.json'
import ja from '../src/i18n/ja.json'
import type { AppSettings } from '../shared/types'

const sync = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  restartSync: vi.fn(),
  status: { status: 'signed-out', detail: 'not signed in', pendingCount: 0 } as {
    status: string
    detail: string
    pendingCount: number
  },
}))

const appStore = vi.hoisted(() => ({
  settings: {
    baby: { name: '아기', birthdate: '2026-01-01' },
    profile: { uid: 'same-user', name: '보호자', role: 'mom' as const },
    firebase: null,
    familyId: '',
    language: 'ko' as const,
  } as AppSettings,
  saveSettings: vi.fn(async () => undefined),
}))

const settingsIpc = vi.hoisted(() => ({
  getSettings: vi.fn(),
  mergeSettings: vi.fn(),
}))

vi.mock('../src/sync/useSync', () => ({
  useSyncStatus: () => sync.status,
  restartSync: sync.restartSync,
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

vi.mock('../src/lib/ipc', () => ({
  ipc: settingsIpc,
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
    sync.restartSync.mockResolvedValue(undefined)
    sync.status = { status: 'signed-out', detail: 'not signed in', pendingCount: 0 }
    appStore.settings = {
      baby: { name: '아기', birthdate: '2026-01-01' },
      profile: { uid: 'same-user', name: '보호자', role: 'mom' },
      firebase: null,
      familyId: '',
      language: 'ko',
    }
    settingsIpc.getSettings.mockImplementation(async () => structuredClone(appStore.settings))
    settingsIpc.mergeSettings.mockImplementation(async (partial: Partial<AppSettings>) => {
      appStore.settings = {
        ...appStore.settings,
        ...partial,
        profile: partial.profile
          ? { ...appStore.settings.profile, ...partial.profile }
          : appStore.settings.profile,
      }
      return structuredClone(appStore.settings)
    })
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

  it('makes the full help card a connected 40px checkbox hit target', async () => {
    await act(async () => root.render(<SyncSettingsSlot />))

    const hitTarget = container.querySelector<HTMLLabelElement>('[data-sync-keep-logged-in-hit-target]')
    const checkbox = container.querySelector<HTMLInputElement>('input[name="keepLoggedIn"]')!
    const help = container.querySelector<HTMLElement>('#sync-keep-logged-in-help')!

    expect(hitTarget?.tagName).toBe('LABEL')
    expect(hitTarget?.contains(checkbox)).toBe(true)
    expect(hitTarget?.contains(help)).toBe(true)
    expect(hitTarget?.querySelector('label')).toBeNull()
    expect(Number.parseFloat(hitTarget?.style.minHeight ?? '0')).toBeGreaterThanOrEqual(40)

    await act(async () => help.click())
    expect(checkbox.checked).toBe(false)
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

  it('persists only the authenticated uid over settings that changed while sign-in was in flight', async () => {
    const initialFirebase = {
      apiKey: 'initial-key',
      authDomain: 'initial.example.test',
      projectId: 'initial-project',
      storageBucket: 'initial-bucket',
      messagingSenderId: 'initial-sender',
      appId: 'initial-app',
    }
    const authoritativeFirebase = {
      apiKey: 'authoritative-key',
      authDomain: 'authoritative.example.test',
      projectId: 'authoritative-project',
      storageBucket: 'authoritative-bucket',
      messagingSenderId: 'authoritative-sender',
      appId: 'authoritative-app',
    }
    appStore.settings = {
      baby: { name: 'Initial baby', birthdate: '2026-01-01' },
      profile: { uid: 'local-placeholder', name: 'Initial parent', role: 'mom' },
      firebase: initialFirebase,
      familyId: 'family-A',
      language: 'ko',
      theme: 'light',
    }
    sync.signIn.mockImplementationOnce(async () => {
      // onAuthStateChanged can publish the authoritative family/settings before
      // this sign-in continuation persists the Firebase uid.
      appStore.settings = {
        baby: { name: 'Authoritative baby', birthdate: '2026-07-04', gender: 'girl' },
        profile: { uid: 'local-placeholder', name: 'Latest parent', role: 'dad' },
        firebase: authoritativeFirebase,
        familyId: 'family-B',
        language: 'ja',
        theme: 'dark',
      }
      return { uid: 'firebase-user-B' }
    })

    await act(async () => root.render(<SyncSettingsSlot />))
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!

    await act(async () => {
      enter(email, 'parent@example.test')
      enter(password, 'secret1')
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(settingsIpc.getSettings).toHaveBeenCalledOnce()
    expect(settingsIpc.mergeSettings).toHaveBeenCalledWith({
      profile: { uid: 'firebase-user-B', name: 'Latest parent', role: 'dad' },
    })
    expect(appStore.saveSettings).not.toHaveBeenCalled()
    expect(appStore.settings).toEqual({
      baby: { name: 'Authoritative baby', birthdate: '2026-07-04', gender: 'girl' },
      profile: { uid: 'firebase-user-B', name: 'Latest parent', role: 'dad' },
      firebase: authoritativeFirebase,
      familyId: 'family-B',
      language: 'ja',
      theme: 'dark',
    })
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

  it.each([
    ['ko', '가족 연결을 지금 확인할 수 없어요. 연결 정보는 그대로 보관했어요. 잠시 후 다시 시도해 주세요.'],
    ['ja', '家族の接続を現在確認できません。接続情報はそのまま保持しています。しばらくしてから再試行してください。'],
  ] as const)('localizes uncertain family access and retries with the preserved identity in %s', async (language, copy) => {
    const firebase = {
      apiKey: 'key',
      authDomain: 'example.test',
      projectId: 'demo-project',
      storageBucket: 'bucket',
      messagingSenderId: 'sender',
      appId: 'app',
    }
    sync.status = { status: 'error', detail: 'FAMILY_ACCESS_UNCERTAIN', pendingCount: 0 }
    appStore.settings = { ...appStore.settings, firebase, familyId: 'family-A', language }
    await i18n.changeLanguage(language)

    await act(async () => root.render(<SyncSettingsSlot />))

    expect(container.textContent).toContain(copy)
    expect(container.textContent).not.toContain('FAMILY_ACCESS_UNCERTAIN')
    const retry = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes(language === 'ko' ? '재시도' : '再試行'))
    expect(retry).toBeDefined()

    await act(async () => retry!.click())

    expect(sync.restartSync).toHaveBeenCalledWith(firebase, 'family-A')
    expect(appStore.settings.familyId).toBe('family-A')
  })
})
