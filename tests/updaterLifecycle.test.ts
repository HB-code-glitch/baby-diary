/**
 * tests/updaterLifecycle.test.ts
 * Unit tests for P22 updater lifecycle (stopUpdater, isUpdaterRunning, idempotent setupUpdater).
 *
 * NOTE: We cannot call setupUpdater() directly (it checks app.isPackaged === true
 * and electron-updater presence).  Instead we test the exported state-management
 * functions in isolation and verify the module shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the electron and electron-updater modules so we can import updater.ts
vi.mock('electron', () => ({
  app: {
    isPackaged: false,  // shouldCheck() → false, so setupUpdater() is a no-op
    getPath: vi.fn(() => '/tmp'),
  },
  ipcMain: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn(async () => {}),
    autoDownload: true,
    autoInstallOnAppQuit: false,
    quitAndInstall: vi.fn(),
  },
}))

describe('updater lifecycle (P22)', () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it('exports stopUpdater, isUpdaterRunning, setupUpdater', async () => {
    const mod = await import('../electron/updater')
    expect(typeof mod.stopUpdater).toBe('function')
    expect(typeof mod.isUpdaterRunning).toBe('function')
    expect(typeof mod.setupUpdater).toBe('function')
  })

  it('isUpdaterRunning returns false when never started (isPackaged=false)', async () => {
    const { isUpdaterRunning } = await import('../electron/updater')
    expect(isUpdaterRunning()).toBe(false)
  })

  it('stopUpdater is safe when never started (no throw)', async () => {
    const { stopUpdater } = await import('../electron/updater')
    expect(() => stopUpdater()).not.toThrow()
  })

  it('isUpdaterRunning returns false after stopUpdater called on never-started engine', async () => {
    const { stopUpdater, isUpdaterRunning } = await import('../electron/updater')
    stopUpdater()
    expect(isUpdaterRunning()).toBe(false)
  })
})
