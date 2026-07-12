/**
 * Auto-update lifecycle for Baby Diary.
 *
 * Packaged Windows NSIS installs update automatically. Portable Windows and
 * macOS builds notify the renderer and send the user to the releases page.
 * Development and E2E runs keep the updater disabled.
 */

import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getUpdateMode } from './updatePolicy'

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

let _focusWindow: BrowserWindow | null = null
let _rendererReady = false
let _rendererReadyListener: (() => void) | null = null
let _windowClosedListener: (() => void) | null = null
let _pendingManualUpdate: ManualUpdatePayload | null = null

function detachUpdaterWindow(): void {
  if (_focusWindow !== null) {
    _focusWindow.removeListener('focus', onWindowFocus)
    if (_rendererReadyListener !== null) {
      _focusWindow.webContents.removeListener('did-finish-load', _rendererReadyListener)
    }
    if (_windowClosedListener !== null) {
      _focusWindow.removeListener('closed', _windowClosedListener)
    }
  }

  _focusWindow = null
  _rendererReady = false
  _rendererReadyListener = null
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

  _rendererReadyListener = () => {
    if (_focusWindow !== window) return
    _rendererReady = true
    sendPendingManualUpdate()
  }
  window.webContents.once('did-finish-load', _rendererReadyListener)

  _windowClosedListener = () => {
    if (_focusWindow === window) detachUpdaterWindow()
  }
  window.once('closed', _windowClosedListener)
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

  detachUpdaterWindow()
  _runCheck = null
  _checking = false
  _lastFocusCheck = 0
  _pendingManualUpdate = null
}

export function setupUpdater(): void {
  const mode = getUpdateMode(
    app.isPackaged,
    Boolean(process.env.BABYDIARY_TEST_USERDATA),
    process.platform,
    process.env.PORTABLE_EXECUTABLE_FILE,
  )
  if (mode === 'off' || _intervalHandle !== null) return

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'HB-code-glitch',
    repo: 'baby-diary-releases',
  } as Parameters<typeof autoUpdater.setFeedURL>[0])

  autoUpdater.autoDownload = mode === 'auto'
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('update-available', (info) => {
    if (mode !== 'manual') return

    const payload = { version: info.version, url: DOWNLOAD_PAGE }
    if (_focusWindow !== null && _rendererReady) {
      _focusWindow.webContents.send('update:available', payload)
      return
    }
    _pendingManualUpdate = payload
  })

  autoUpdater.on('update-downloaded', (info) => {
    if (mode !== 'auto' || _focusWindow === null || !_rendererReady) return
    _focusWindow.webContents.send('update:ready', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    console.error('[Updater] error:', err?.message ?? err)
  })

  ipcMain.on('update:install', () => {
    if (mode !== 'auto') return
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      console.error('[Updater] quitAndInstall error:', err)
    }
  })

  ipcMain.on('update:openDownload', () => {
    if (mode !== 'manual') return
    shell.openExternal(DOWNLOAD_PAGE).catch(err =>
      console.error('[Updater] openExternal error:', err)
    )
  })

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
