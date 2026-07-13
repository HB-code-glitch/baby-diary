import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { registerFirebasePersistenceIPC } from '../electron/firebasePersistenceIPC'

describe('Firebase persistence claim IPC boundary', () => {
  it('publishes/loads the immutable registry before current stores, IPC, or renderer startup', () => {
    const main = readFileSync(resolve(import.meta.dirname, '../electron/main.ts'), 'utf8')
    const startup = main.slice(main.indexOf('app.whenReady().then'))
    const snapshot = startup.indexOf('detectPreexistingFirebaseProfile(userDataPath)')
    const registry = startup.indexOf('FirebasePersistenceRegistry.open(')
    const backup = startup.indexOf('new BackupManager(userDataPath)')
    const settings = startup.indexOf('new SettingsStore(userDataPath')
    const ipc = startup.indexOf('setupIPC()')
    const renderer = startup.indexOf('createWindow()')

    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(snapshot).toBeLessThan(registry)
    expect(registry).toBeLessThan(backup)
    expect(registry).toBeLessThan(settings)
    expect(settings).toBeLessThan(ipc)
    expect(ipc).toBeLessThan(renderer)
  })

  it('exposes one fixed preload channel with exact request/response validation', () => {
    const preload = readFileSync(resolve(import.meta.dirname, '../electron/preload.ts'), 'utf8')
    expect(preload).toContain("ipcRenderer.invoke('firebase:claimPersistence', config)")
    expect(preload).toContain('parseFirebaseConfig(rawConfig)')
    expect(preload).toContain('parseFirebaseClaim(response, config)')
    expect(preload).not.toContain('rendererFingerprint')
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
