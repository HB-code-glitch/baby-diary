/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../shared/types'
import { LANG_CHOSEN_KEY } from '../src/components/LanguagePicker'
import i18n from '../src/i18n'
import { ipc } from '../src/lib/ipc'
import { useAppStore } from '../src/store/useAppStore'

vi.mock('../src/sync/useSync', () => ({ useSyncLifecycle: () => undefined }))
vi.mock('../src/lib/useMidnightRefresh', () => ({ useMidnightRefresh: () => undefined }))
vi.mock('../src/components/Sidebar', () => ({
  Sidebar: () => <nav data-test-sidebar />,
}))
vi.mock('../src/components/TutorialTour', () => ({
  TutorialTour: () => <div data-test-tutorial="true" />,
}))
vi.mock('../src/components/UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('../src/pages/HomePage', () => ({ HomePage: () => <div data-test-home /> }))

import App from '../src/App'

const SETTINGS: AppSettings = {
  baby: { name: '보존할 아기', birthdate: '2024-01-02', gender: 'female' },
  profile: { uid: 'uid-keep', name: '보존할 보호자', role: 'mom' },
  familyId: 'family-keep',
  firebase: null,
  theme: 'dark',
}

const originalStore = useAppStore.getState()

function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

describe('tutorial startup hydration and language persistence', () => {
  let container: HTMLDivElement
  let root: Root
  let mergeSettings: ReturnType<typeof vi.spyOn>
  let fullSave: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    installMatchMedia()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fullSave = vi.fn(async () => undefined)
    useAppStore.setState({
      settings: null,
      isReady: false,
      init: vi.fn(async () => undefined),
      loadSettings: vi.fn(async () => undefined),
      saveSettings: fullSave,
    })
    mergeSettings = vi.spyOn(ipc, 'mergeSettings').mockResolvedValue(undefined)
    await i18n.changeLanguage('ko')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    mergeSettings.mockRestore()
    useAppStore.setState({
      settings: originalStore.settings,
      isReady: originalStore.isReady,
      init: originalStore.init,
      loadSettings: originalStore.loadSettings,
      saveSettings: originalStore.saveSettings,
    })
    document.documentElement.removeAttribute('data-lang')
    document.documentElement.removeAttribute('lang')
    await i18n.changeLanguage('ko')
    vi.useRealTimers()
  })

  it('waits for slow settings hydration before deciding whether to show the picker or tutorial', async () => {
    await act(async () => root.render(<App />))
    await act(async () => vi.advanceTimersByTime(1_000))

    expect(document.body.querySelector('.lang-picker-overlay')).toBeNull()
    expect(document.body.querySelector('[data-test-tutorial]')).toBeNull()

    await act(async () => {
      useAppStore.setState({ settings: SETTINGS, isReady: true })
      await Promise.resolve()
    })

    expect(document.body.querySelector('.lang-picker-overlay')).not.toBeNull()
    expect(document.body.querySelector('[data-test-tutorial]')).toBeNull()
  })

  it('treats a persisted language as authoritative for an existing user even without the legacy local flag', async () => {
    await act(async () => root.render(<App />))
    await act(async () => {
      useAppStore.setState({ settings: { ...SETTINGS, language: 'ja' }, isReady: true })
      await Promise.resolve()
    })

    expect(document.body.querySelector('.lang-picker-overlay')).toBeNull()
    expect(document.body.querySelector('[data-test-tutorial]')).not.toBeNull()
    expect(document.documentElement.getAttribute('lang')).toBe('ja')
  })

  it('migrates a legacy chosen marker with a missing settings language through the partial merge API', async () => {
    localStorage.setItem(LANG_CHOSEN_KEY, '1')
    await act(async () => root.render(<App />))
    await act(async () => {
      useAppStore.setState({ settings: SETTINGS, isReady: true })
      await Promise.resolve()
    })

    expect(document.body.querySelector('.lang-picker-overlay')).toBeNull()
    expect(document.body.querySelector('[data-test-tutorial]')).not.toBeNull()
    expect(mergeSettings).toHaveBeenCalledWith({ language: 'ko' })
    expect(useAppStore.getState().settings).toEqual({ ...SETTINGS, language: 'ko' })
  })

  it('persists only the selected language with mergeSettings and keeps the hydrated profile in memory', async () => {
    await act(async () => root.render(<App />))
    await act(async () => {
      useAppStore.setState({ settings: SETTINGS, isReady: true })
      await Promise.resolve()
    })

    const korean = document.body.querySelector<HTMLButtonElement>('.lang-picker-btn[lang="ko"]')!
    await act(async () => {
      korean.click()
      await Promise.resolve()
    })

    expect(mergeSettings).toHaveBeenCalledTimes(1)
    expect(mergeSettings).toHaveBeenCalledWith({ language: 'ko' })
    expect(fullSave).not.toHaveBeenCalled()
    expect(useAppStore.getState().settings).toEqual({ ...SETTINGS, language: 'ko' })
    expect(localStorage.getItem(LANG_CHOSEN_KEY)).toBe('1')
    expect(document.body.querySelector('[data-test-tutorial]')).not.toBeNull()
  })

  it('keeps language and store state converged after a persistence failure but retries persistence next launch', async () => {
    mergeSettings.mockRejectedValueOnce(new Error('disk full'))
    await act(async () => root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ))
    await act(async () => {
      useAppStore.setState({ settings: SETTINGS, isReady: true })
      await Promise.resolve()
    })

    const japanese = document.body.querySelector<HTMLButtonElement>('.lang-picker-btn[lang="ja"]')!
    await act(async () => {
      japanese.click()
      japanese.click()
      await Promise.resolve()
    })

    expect(mergeSettings).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().settings).toEqual({ ...SETTINGS, language: 'ja' })
    expect(document.documentElement.getAttribute('lang')).toBe('ja')
    expect(localStorage.getItem(LANG_CHOSEN_KEY)).toBeNull()
    expect(document.body.querySelector('.lang-picker-overlay')).toBeNull()
    expect(document.body.querySelector('[data-test-tutorial]')).not.toBeNull()
  })

  it('makes the first-launch decision only once under React StrictMode', async () => {
    await act(async () => root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ))
    await act(async () => {
      useAppStore.setState({ settings: SETTINGS, isReady: true })
      await Promise.resolve()
    })

    expect(document.body.querySelectorAll('.lang-picker-overlay')).toHaveLength(1)
    expect(document.body.querySelector('[data-test-tutorial]')).toBeNull()
  })
})
