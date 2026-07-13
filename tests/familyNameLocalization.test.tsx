/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../shared/types'
import i18n from '../src/i18n'
import { useAppStore } from '../src/store/useAppStore'

const syncMocks = vi.hoisted(() => ({
  state: { status: 'signed-out', detail: 'family-needed', pendingCount: 0, inviteCode: null },
  createFamily: vi.fn(),
}))

vi.mock('../src/sync/useSync', () => ({
  useSyncStatus: () => syncMocks.state,
  restartSync: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOutSync: vi.fn(),
  createFamily: syncMocks.createFamily,
  joinFamily: vi.fn(),
  DETAIL_FAMILY_GONE: 'family-gone',
}))
vi.mock('../src/sync/syncEngine', () => ({
  DETAIL_FAMILY_NEEDED: 'family-needed',
  DETAIL_FAMILY_NOT_FOUND: 'family-not-found',
  ERR_NOT_SIGNED_IN: 'not-signed-in',
  ERR_PERMISSION_DENIED: 'permission-denied',
}))

import { SyncSettingsSlot } from '../src/components/SyncSettingsSlot'

const originalStore = useAppStore.getState()

function settings(name: string, familyId = ''): AppSettings {
  return {
    baby: { name: '하루', birthdate: '2024-01-01' },
    profile: { uid: 'uid-1', name, role: 'mom' },
    familyId,
    firebase: null,
  }
}

describe('new family name localization', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    syncMocks.state = { status: 'signed-out', detail: 'family-needed', pendingCount: 0, inviteCode: null }
    syncMocks.createFamily.mockReset().mockResolvedValue({ familyId: 'new-family', inviteCode: 'ABC123' })
    useAppStore.setState({
      settings: settings(''),
      saveSettings: vi.fn(async () => undefined),
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState({ settings: originalStore.settings, saveSettings: originalStore.saveSettings })
    await i18n.changeLanguage('ko')
  })

  it.each([
    ['ko', '민수', '민수의 가족'],
    ['ja', 'さくら', 'さくらの家族'],
  ] as const)('uses the active %s grammar only when creating a new family', async (language, profileName, expected) => {
    await i18n.changeLanguage(language)
    useAppStore.setState({ settings: settings(profileName) })
    await act(async () => root.render(<SyncSettingsSlot />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-sync-family-choice="create"]')!.click())
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-sync-family-submit="create"]')!.click()
      await Promise.resolve()
    })

    expect(syncMocks.createFamily).toHaveBeenCalledTimes(1)
    expect(syncMocks.createFamily.mock.calls[0][0]).toMatchObject({ familyName: expected })
  })

  it.each([
    ['ko', '우리 가족'],
    ['ja', 'わが家'],
  ] as const)('uses a localized neutral default in %s when the profile name is blank', async (language, expected) => {
    await i18n.changeLanguage(language)
    useAppStore.setState({ settings: settings('   ') })
    await act(async () => root.render(<SyncSettingsSlot />))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-sync-family-choice="create"]')!.click())
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-sync-family-submit="create"]')!.click()
      await Promise.resolve()
    })

    expect(syncMocks.createFamily.mock.calls[0][0]).toMatchObject({ familyName: expected })
  })

  it('does not rewrite an existing cloud family name during an online settings render', async () => {
    syncMocks.state = { status: 'online', detail: 'ready', pendingCount: 0, inviteCode: 'ABC123' }
    useAppStore.setState({ settings: settings('민수', 'existing-family') })
    await act(async () => root.render(<SyncSettingsSlot />))

    expect(syncMocks.createFamily).not.toHaveBeenCalled()
  })
})
