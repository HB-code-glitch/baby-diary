// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../shared/types'

function settings(name: string): AppSettings {
  return {
    baby: { name, birthdate: '2026-01-01' },
    profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
    familyId: 'family-A',
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
})
