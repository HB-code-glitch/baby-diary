import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { registerFirebasePersistenceIPC } from '../electron/firebasePersistenceIPC'
import { DEFAULT_FIREBASE_CONFIG } from '../shared/defaultFirebaseConfig'
import {
  canonicalFirebaseConfig,
  getUnreleasedFNVFirebaseAppName,
} from '../shared/firebasePersistence'

describe('Firebase persistence claim IPC boundary', () => {
  it('recovers corrupt settings before publication and otherwise publishes before SettingsStore', () => {
    const main = readFileSync(resolve(import.meta.dirname, '../electron/main.ts'), 'utf8')
    const startup = main.slice(main.indexOf('app.whenReady().then'))
    const snapshot = startup.indexOf('detectPreexistingFirebaseProfile(userDataPath)')
    const backup = startup.indexOf('new BackupManager(userDataPath)')
    const recoveryBranch = startup.indexOf("if (firebaseProfileEligibility.kind === 'settings-invalid')")
    const recoverySettings = startup.indexOf('new SettingsStore(userDataPath', recoveryBranch)
    const recoveredRegistry = startup.indexOf(
      'FirebasePersistenceRegistry.openAfterSettingsRecovery(',
      recoverySettings,
    )
    const normalBranch = startup.indexOf('} else {', recoveredRegistry)
    const normalRegistry = startup.indexOf('FirebasePersistenceRegistry.open(', normalBranch)
    const normalSettings = startup.indexOf('new SettingsStore(userDataPath', normalRegistry)
    const eventLog = startup.indexOf('new EventLog(', normalSettings)
    const ipc = startup.indexOf('setupIPC()')
    const renderer = startup.indexOf('createWindow()')

    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(snapshot).toBeLessThan(backup)
    expect(backup).toBeLessThan(recoveryBranch)
    expect(recoveryBranch).toBeLessThan(recoverySettings)
    expect(recoverySettings).toBeLessThan(recoveredRegistry)
    expect(recoveredRegistry).toBeLessThan(normalBranch)
    expect(normalBranch).toBeLessThan(normalRegistry)
    expect(normalRegistry).toBeLessThan(normalSettings)
    expect(normalSettings).toBeLessThan(eventLog)
    expect(eventLog).toBeLessThan(ipc)
    expect(ipc).toBeLessThan(renderer)
  })

  it('exposes one fixed preload channel with exact request/response validation', () => {
    const preload = readFileSync(resolve(import.meta.dirname, '../electron/preload.ts'), 'utf8')
    expect(preload).toContain("ipcRenderer.invoke('firebase:claimPersistence', config)")
    expect(preload).toContain('parseFirebaseConfig(rawConfig)')
    expect(preload).toContain('parseFirebaseClaim(response, config)')
    expect(preload).not.toContain('rendererFingerprint')
  })

  it('accepts only the exact evidence-owned FNV v2 claim in the sandboxed preload', async () => {
    vi.resetModules()
    let exposedApi: {
      claimFirebasePersistence(config: typeof DEFAULT_FIREBASE_CONFIG): Promise<unknown>
    } | undefined
    let response: unknown
    const invoke = vi.fn(async () => response)
    vi.doMock('electron', () => ({
      contextBridge: {
        exposeInMainWorld: (_key: string, api: typeof exposedApi) => { exposedApi = api },
      },
      ipcRenderer: {
        invoke,
        on: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
      },
    }))
    await import('../electron/preload')
    expect(exposedApi).toBeDefined()

    const configIdentity = canonicalFirebaseConfig(DEFAULT_FIREBASE_CONFIG)
    const appName = getUnreleasedFNVFirebaseAppName(DEFAULT_FIREBASE_CONFIG)
    response = {
      version: 2,
      ownership: 'main-registry-fnv-evidence',
      configIdentity,
      appName,
    }
    await expect(exposedApi!.claimFirebasePersistence(DEFAULT_FIREBASE_CONFIG)).resolves.toEqual(response)

    for (const invalid of [
      { version: 1, configIdentity, appName },
      { version: 2, ownership: 'main-registry-fnv-evidence', configIdentity, appName: 'baby-diary-deadbeefdeadbeef' },
      { version: 2, ownership: 'renderer-fnv-evidence', configIdentity, appName },
      { version: 2, ownership: 'main-registry-fnv-evidence', configIdentity, appName, extra: true },
    ]) {
      response = invalid
      await expect(exposedApi!.claimFirebasePersistence(DEFAULT_FIREBASE_CONFIG))
        .rejects.toThrow(/claim response is invalid/i)
    }
    vi.doUnmock('electron')
    vi.resetModules()
  })

  it('accepts only the current main frame and delegates raw config to main validation', async () => {
    let handler: ((event: unknown, config: unknown) => Promise<unknown>) | undefined
    const ipcMain = {
      handle: vi.fn((channel: string, value: typeof handler) => {
        expect(channel).toBe('firebase:claimPersistence')
        handler = value
      }),
    }
    const mainFrame = { frameId: 1 }
    const webContents = { mainFrame }
    const window = { webContents }
    const claim = vi.fn(config => ({ version: 1, configIdentity: 'main-owned', appName: 'baby-diary' }))
    registerFirebasePersistenceIPC(
      ipcMain as never,
      { claim } as never,
      () => window as never,
    )
    const config = { rendererFingerprint: 'must-not-be-trusted' }

    await expect(handler?.({ sender: webContents, senderFrame: mainFrame }, config))
      .resolves.toMatchObject({ appName: 'baby-diary' })
    expect(claim).toHaveBeenCalledWith(config)
  })

  it.each([
    ['subframe', (webContents: object, mainFrame: object) => ({ sender: webContents, senderFrame: {} })],
    ['other renderer', (_webContents: object, mainFrame: object) => ({ sender: {}, senderFrame: mainFrame })],
  ])('rejects an untrusted %s without invoking registry claim', async (_label, makeEvent) => {
    let handler: ((event: unknown, config: unknown) => Promise<unknown>) | undefined
    const mainFrame = { frameId: 1 }
    const webContents = { mainFrame }
    const claim = vi.fn()
    registerFirebasePersistenceIPC(
      { handle: (_channel: string, value: typeof handler) => { handler = value } } as never,
      { claim } as never,
      () => ({ webContents }) as never,
    )

    await expect(handler?.(makeEvent(webContents, mainFrame), {}))
      .rejects.toThrow(/untrusted renderer/i)
    expect(claim).not.toHaveBeenCalled()
  })
})
