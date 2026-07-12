import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getUpdateMode } from '../electron/updatePolicy'

const DOWNLOAD_PAGE = 'https://github.com/HB-code-glitch/baby-diary-releases/releases/latest'

describe('update policy', () => {
  it('disables updates in development', () => {
    expect(getUpdateMode(false, false, 'win32', undefined)).toBe('off')
  })

  it('disables updates during E2E runs', () => {
    expect(getUpdateMode(true, true, 'win32', undefined)).toBe('off')
  })

  it('automatically updates packaged Windows NSIS installs', () => {
    expect(getUpdateMode(true, false, 'win32', undefined)).toBe('auto')
  })

  it('manually updates packaged Windows portable builds', () => {
    expect(getUpdateMode(true, false, 'win32', 'C:\\BabyDiary\\Baby Diary.exe')).toBe('manual')
  })

  it('manually updates packaged macOS builds', () => {
    expect(getUpdateMode(true, false, 'darwin', undefined)).toBe('manual')
  })
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')

  class MockBrowserWindow extends EventEmitter {
    static getAllWindows = vi.fn(() => [] as MockBrowserWindow[])

    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
    })
  }

  return {
    app: Object.assign(new EventEmitter(), {
      isPackaged: false,
      getPath: vi.fn(() => '/tmp'),
    }),
    ipcMain: new EventEmitter(),
    shell: { openExternal: vi.fn(async () => {}) },
    BrowserWindow: MockBrowserWindow,
  }
})

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')

  return {
    autoUpdater: Object.assign(new EventEmitter(), {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(async () => {}),
      autoDownload: true,
      autoInstallOnAppQuit: false,
      quitAndInstall: vi.fn(),
    }),
  }
})

type MockFn = ReturnType<typeof vi.fn>
type MockWebContents = EventEmitter & { send: MockFn }
type MockWindow = EventEmitter & { webContents: MockWebContents }
type MockApp = EventEmitter & { isPackaged: boolean }
type MockIpcMain = EventEmitter
type MockBrowserWindow = {
  new (): MockWindow
  getAllWindows: MockFn
}
type MockAutoUpdater = EventEmitter & {
  setFeedURL: MockFn
  checkForUpdates: MockFn
  quitAndInstall: MockFn
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
}

async function getHarness() {
  const electron = await import('electron')
  const electronUpdater = await import('electron-updater')

  return {
    app: electron.app as unknown as MockApp,
    ipcMain: electron.ipcMain as unknown as MockIpcMain,
    shell: electron.shell as unknown as { openExternal: MockFn },
    BrowserWindow: electron.BrowserWindow as unknown as MockBrowserWindow,
    autoUpdater: electronUpdater.autoUpdater as unknown as MockAutoUpdater,
  }
}

describe('updater lifecycle', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    delete process.env.BABYDIARY_TEST_USERDATA
    delete process.env.PORTABLE_EXECUTABLE_FILE

    const { app, ipcMain, shell, BrowserWindow, autoUpdater } = await getHarness()
    app.removeAllListeners()
    app.isPackaged = false
    ipcMain.removeAllListeners()
    BrowserWindow.getAllWindows.mockReset().mockReturnValue([])
    autoUpdater.removeAllListeners()
    autoUpdater.setFeedURL.mockReset()
    autoUpdater.checkForUpdates.mockReset().mockResolvedValue(undefined)
    autoUpdater.quitAndInstall.mockReset()
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    shell.openExternal.mockReset().mockResolvedValue(undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    const { stopUpdater } = await import('../electron/updater')
    stopUpdater()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete process.env.BABYDIARY_TEST_USERDATA
    delete process.env.PORTABLE_EXECUTABLE_FILE
  })

  it('exports the updater lifecycle API and is stopped when updates are off', async () => {
    const updater = await import('../electron/updater')

    expect(updater.setupUpdater).toBeTypeOf('function')
    expect(updater.stopUpdater).toBeTypeOf('function')
    expect(updater.isUpdaterRunning).toBeTypeOf('function')
    updater.setupUpdater()
    expect(updater.isUpdaterRunning()).toBe(false)
    expect(() => updater.stopUpdater()).not.toThrow()
  })

  it('starts once and stops both scheduled checks', async () => {
    const { app } = await getHarness()
    app.isPackaged = true
    const updater = await import('../electron/updater')

    updater.setupUpdater()
    updater.setupUpdater()

    expect(updater.isUpdaterRunning()).toBe(true)
    expect(vi.getTimerCount()).toBe(2)

    updater.stopUpdater()
    expect(updater.isUpdaterRunning()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks after 15 seconds and again at the 30-minute interval', async () => {
    const { app, autoUpdater } = await getHarness()
    app.isPackaged = true
    const { setupUpdater } = await import('../electron/updater')

    setupUpdater()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 - 15_000)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('moves the focus listener from the old main window to its replacement', async () => {
    const { app, BrowserWindow } = await getHarness()
    app.isPackaged = true
    const updater = await import('../electron/updater') as typeof import('../electron/updater') & {
      attachUpdaterWindow?: (window: MockWindow) => void
    }
    const oldWindow = new BrowserWindow()
    const newWindow = new BrowserWindow()

    updater.setupUpdater()
    expect(updater.attachUpdaterWindow).toBeTypeOf('function')
    updater.attachUpdaterWindow!(oldWindow)
    expect(oldWindow.listenerCount('focus')).toBe(1)

    updater.attachUpdaterWindow!(newWindow)

    expect(oldWindow.listenerCount('focus')).toBe(0)
    expect(newWindow.listenerCount('focus')).toBe(1)
  })

  it('delivers one pending manual update after the replacement renderer loads', async () => {
    process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\BabyDiary\\Baby Diary.exe'
    const { app, ipcMain, BrowserWindow, autoUpdater } = await getHarness()
    app.isPackaged = true
    const updater = await import('../electron/updater') as typeof import('../electron/updater') & {
      attachUpdaterWindow?: (window: MockWindow) => void
    }

    updater.setupUpdater()
    expect(autoUpdater.autoDownload).toBe(false)
    ipcMain.emit('update:install')
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    autoUpdater.emit('update-available', { version: '0.4.0' })

    const replacementWindow = new BrowserWindow()
    expect(updater.attachUpdaterWindow).toBeTypeOf('function')
    updater.attachUpdaterWindow!(replacementWindow)
    expect(replacementWindow.webContents.send).not.toHaveBeenCalled()

    replacementWindow.webContents.emit('did-finish-load')

    expect(replacementWindow.webContents.send).toHaveBeenCalledTimes(1)
    expect(replacementWindow.webContents.send).toHaveBeenCalledWith('update:available', {
      version: '0.4.0',
      url: DOWNLOAD_PAGE,
    })

    replacementWindow.webContents.emit('did-finish-load')
    expect(replacementWindow.webContents.send).toHaveBeenCalledTimes(1)
  })
})
