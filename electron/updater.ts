/**
 * Auto-update lifecycle for Baby Diary.
 *
 * Packaged Windows NSIS installs update automatically. Portable Windows and
 * macOS builds notify the renderer and send the user to the releases page.
 * Development and E2E runs keep the updater disabled.
 */

import { app, ipcMain, shell, type BrowserWindow, type IpcMainEvent } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getUpdateMode, type UpdateMode } from './updatePolicy'

const DOWNLOAD_PAGE = 'https://github.com/HB-code-glitch/baby-diary-releases/releases/latest'
const INTERVAL_MS = 30 * 60 * 1_000
const FOCUS_THROTTLE = 10 * 60 * 1_000

type CheckTrigger = 'start' | 'interval' | 'focus'
type ManualUpdatePayload = { version: string; url: string }

let _initialTimeout: ReturnType<typeof setTimeout> | null = null
let _intervalHandle: ReturnType<typeof setInterval> | null = null
let _checking = false
let _lastFocusCheck = 0
let _runCheck: ((trigger: CheckTrigger) => void) | null = null
let _mode: UpdateMode = 'off'

let _focusWindow: BrowserWindow | null = null
let _rendererReady = false
let _windowClosedListener: (() => void) | null = null
let _pendingManualUpdate: ManualUpdatePayload | null = null

function detachUpdaterWindow(): void {
  if (_focusWindow !== null) {
    _focusWindow.removeListener('focus', onWindowFocus)
    if (_windowClosedListener !== null) {
      _focusWindow.removeListener('closed', _windowClosedListener)
    }
  }

  _focusWindow = null
  _rendererReady = false
  _windowClosedListener = null
}

function sendPendingManualUpdate(): void {
  if (_focusWindow === null || !_rendererReady || _pendingManualUpdate === null) return
  _focusWindow.webContents.send('update:available', _pendingManualUpdate)
  _pendingManualUpdate = null
}

function onWindowFocus(): void {
  if (_runCheck === null) return

  const now = Date.now()
  if (now - _lastFocusCheck < FOCUS_THROTTLE) {
    console.log('[Updater] focus check throttled - skipping')
    return
  }

  _lastFocusCheck = now
  _runCheck('focus')
}

/** Attach updater behavior to the current main window. */
export function attachUpdaterWindow(window: BrowserWindow): void {
  detachUpdaterWindow()
  _focusWindow = window
  window.on('focus', onWindowFocus)

  _windowClosedListener = () => {
    if (_focusWindow === window) detachUpdaterWindow()
  }
  window.once('closed', _windowClosedListener)
}

function handleUpdateAvailable(info: { version: string }): void {
  if (_mode !== 'manual') return

  const payload = { version: info.version, url: DOWNLOAD_PAGE }
  if (_focusWindow !== null && _rendererReady) {
    _focusWindow.webContents.send('update:available', payload)
    return
  }
  _pendingManualUpdate = payload
}

function handleUpdateDownloaded(info: { version: string }): void {
  if (_mode !== 'auto' || _focusWindow === null || !_rendererReady) return
  _focusWindow.webContents.send('update:ready', { version: info.version })
}

function handleUpdaterError(err: Error): void {
  console.error('[Updater] error:', err?.message ?? err)
}

function handleInstallUpdate(): void {
  if (_mode !== 'auto') return
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    console.error('[Updater] quitAndInstall error:', err)
  }
}

function handleOpenDownload(): void {
  if (_mode !== 'manual') return
  shell.openExternal(DOWNLOAD_PAGE).catch(err =>
    console.error('[Updater] openExternal error:', err)
  )
}

function handleRendererReady(event?: IpcMainEvent): void {
  if (_focusWindow === null || event?.sender !== _focusWindow.webContents) return
  _rendererReady = true
  sendPendingManualUpdate()
}

function registerUpdaterHandlers(): void {
  autoUpdater.on('update-available', handleUpdateAvailable)
  autoUpdater.on('update-downloaded', handleUpdateDownloaded)
  autoUpdater.on('error', handleUpdaterError)
  ipcMain.on('update:install', handleInstallUpdate)
  ipcMain.on('update:openDownload', handleOpenDownload)
  ipcMain.on('update:rendererReady', handleRendererReady)
}

function unregisterUpdaterHandlers(): void {
  autoUpdater.removeListener('update-available', handleUpdateAvailable)
  autoUpdater.removeListener('update-downloaded', handleUpdateDownloaded)
  autoUpdater.removeListener('error', handleUpdaterError)
  ipcMain.removeListener('update:install', handleInstallUpdate)
  ipcMain.removeListener('update:openDownload', handleOpenDownload)
  ipcMain.removeListener('update:rendererReady', handleRendererReady)
}

export function isUpdaterRunning(): boolean {
  return _intervalHandle !== null
}

/** Stop updater timers and detach the active main window. */
export function stopUpdater(): void {
  if (_initialTimeout !== null) {
    clearTimeout(_initialTimeout)
    _initialTimeout = null
  }
  if (_intervalHandle !== null) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
  }

  unregisterUpdaterHandlers()
  detachUpdaterWindow()
  _runCheck = null
  _checking = false
  _lastFocusCheck = 0
  _pendingManualUpdate = null
  _mode = 'off'
}

export function setupUpdater(): void {
  const mode = getUpdateMode(
    app.isPackaged,
    Boolean(process.env.BABYDIARY_TEST_USERDATA),
    process.platform,
    process.env.PORTABLE_EXECUTABLE_FILE,
  )
  if (mode === 'off' || _intervalHandle !== null) return
  _mode = mode

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'HB-code-glitch',
    repo: 'baby-diary-releases',
  } as Parameters<typeof autoUpdater.setFeedURL>[0])

  autoUpdater.autoDownload = mode === 'auto'
  autoUpdater.autoInstallOnAppQuit = false
  unregisterUpdaterHandlers()
  registerUpdaterHandlers()

  function runCheck(trigger: CheckTrigger): void {
    if (_checking) {
      console.log(`[Updater] check skipped (in-flight) - trigger: ${trigger}`)
      return
    }

    console.log(`[Updater] checking for updates - trigger: ${trigger}`)
    _checking = true
    autoUpdater.checkForUpdates()
      .catch(err => console.error('[Updater] checkForUpdates error:', err?.message ?? err))
      .finally(() => { _checking = false })
  }

  _runCheck = runCheck
  _initialTimeout = setTimeout(() => runCheck('start'), 15_000)
  _intervalHandle = setInterval(() => runCheck('interval'), INTERVAL_MS)
}
