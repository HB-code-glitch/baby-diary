// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../shared/types'

function settings(name: string, familyId = 'family-A'): AppSettings {
  return {
    baby: { name, birthdate: '2026-01-01' },
    profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
    familyId,
    firebase: null,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('authoritative main settings broadcast bridge', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    delete (window as Partial<Window>).babyDiary
  })

  it('installs before hydration, keeps a newer broadcast over a stale getSettings result, and does not write it back', async () => {
    const hydration = deferred<AppSettings>()
    let settingsCallback: ((payload: { sequence: number; settings: AppSettings }) => void) | undefined
    const saveSettings = vi.fn(async (value: AppSettings) => value)
    const bridge = {
      getFirebaseEmulator: async () => null,
      openEvidenceSource: async () => undefined,
      listEvents: async () => [],
      listEventMutations: async () => [],
      appendEvent: async () => 'ok' as const,
      getSettings: vi.fn(() => hydration.promise),
      saveSettings,
      mergeSettings: async (value: Partial<AppSettings>) => ({ ...settings('merge'), ...value }),
      commitBabyInfo: vi.fn(),
      listPendingBabyInfo: vi.fn(),
      getBabyInfoSummary: vi.fn(),
      exportData: async () => undefined,
      openBackupFolder: async () => undefined,
      getDataInfo: async () => ({
        dataDir: '', backupDir: '', documentsBackupDir: '', eventCount: 0, lastBackupTime: null,
      }),
      onEventAppended: () => () => undefined,
      onSettingsChanged: (callback: (payload: { sequence: number; settings: AppSettings }) => void) => {
        settingsCallback = callback
        return () => { settingsCallback = undefined }
      },
      onUpdateReady: () => () => undefined,
      onUpdateAvailable: () => () => undefined,
      updateRendererReady: () => undefined,
      installUpdate: () => undefined,
      openUpdateDownload: () => undefined,
      savePdf: async () => ({ saved: false as const }),
      reportReady: () => undefined,
    }
    Object.defineProperty(window, 'babyDiary', { configurable: true, value: bridge })

    const { useAppStore, disposeAppStoreSettingsBridge } = await import('../src/store/useAppStore')
    const init = useAppStore.getState().init()
    await vi.waitFor(() => expect(settingsCallback).toBeTypeOf('function'))

    settingsCallback!({ sequence: 2, settings: settings('Cloud winner') })
    hydration.resolve(settings('Stale hydration'))
    await init

    expect(useAppStore.getState().settings?.baby.name).toBe('Cloud winner')
    expect(saveSettings).not.toHaveBeenCalled()

    settingsCallback!({ sequence: 1, settings: settings('Late stale broadcast') })
    expect(useAppStore.getState().settings?.baby.name).toBe('Cloud winner')
    disposeAppStoreSettingsBridge()
    expect(settingsCallback).toBeUndefined()
  })

  it('clears the old family view immediately and reloads only the new family after a family change', async () => {
    let settingsCallback: ((payload: { sequence: number; settings: AppSettings }) => void) | undefined
    const familyAEvent = {
      id: 'family-a-event', mutationId: '11111111-1111-4111-8111-111111111111', type: 'pee' as const,
      at: '2026-07-15T00:00:00.000Z', data: {}, author: { uid: 'a', name: 'A', role: 'dad' as const },
      createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', rev: 1, deleted: false,
    }
    const familyBEvent = {
      ...familyAEvent,
      id: 'family-b-event',
      mutationId: '22222222-2222-4222-8222-222222222222',
      author: { uid: 'b', name: 'B', role: 'mom' as const },
    }
    const listEvents = vi.fn()
      .mockResolvedValueOnce([familyAEvent])
      .mockResolvedValueOnce([familyBEvent])
    const bridge = {
      getFirebaseEmulator: async () => null,
      openEvidenceSource: async () => undefined,
      listEvents,
      listEventMutations: async () => [],
      appendEvent: async () => 'ok' as const,
      getSettings: async () => settings('Family A', 'family-A'),
      saveSettings: async (value: AppSettings) => value,
      mergeSettings: async (value: Partial<AppSettings>) => ({ ...settings('merge'), ...value }),
      commitBabyInfo: vi.fn(), listPendingBabyInfo: vi.fn(), getBabyInfoSummary: vi.fn(),
      exportData: async () => undefined, openBackupFolder: async () => undefined,
      getDataInfo: async () => ({ dataDir: '', backupDir: '', documentsBackupDir: '', eventCount: 1, lastBackupTime: null }),
      onEventAppended: () => () => undefined,
      onSettingsChanged: (callback: (payload: { sequence: number; settings: AppSettings }) => void) => {
        settingsCallback = callback
        return () => { settingsCallback = undefined }
      },
      onUpdateReady: () => () => undefined, onUpdateAvailable: () => () => undefined,
      updateRendererReady: () => undefined, installUpdate: () => undefined,
      openUpdateDownload: () => undefined, savePdf: async () => ({ saved: false as const }),
      reportReady: () => undefined,
    }
    Object.defineProperty(window, 'babyDiary', { configurable: true, value: bridge })

    const { useAppStore } = await import('../src/store/useAppStore')
    await useAppStore.getState().init()
    expect(useAppStore.getState().events).toEqual([familyAEvent])

    settingsCallback!({ sequence: 1, settings: settings('Family B', 'family-B') })
    expect(useAppStore.getState().events).toEqual([])
    await vi.waitFor(() => expect(useAppStore.getState().events).toEqual([familyBEvent]))
    expect(listEvents).toHaveBeenCalledTimes(2)
  })
})
