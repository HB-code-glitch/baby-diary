/**
 * Auto-update module for Baby Diary.
 *
 * Rules:
 *  - Only active when app.isPackaged AND env BABYDIARY_TEST_USERDATA is NOT set.
 *  - Windows: autoDownload true → IPC update:ready when download complete.
 *  - macOS: autoDownload false → IPC update:available with download URL (browser-open).
 *  - All errors are swallowed (updates must never crash or annoy).
 *
 * Check schedule:
 *  - Immediate: 15 s after app ready (startup trigger).
 *  - Interval: every 30 minutes (periodic trigger).
 *  - Focus: when main window gains focus, throttled to at most once per 10 minutes.
 *  - In-flight guard: concurrent checks are skipped (electron-updater tolerates
 *    them, but explicit guard makes log lines unambiguous).
 */

import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

const DOWNLOAD_PAGE = 'https://github.com/HB-code-glitch/baby-diary-releases/releases/latest'

const INTERVAL_MS    = 30 * 60 * 1_000   // 30 minutes
const FOCUS_THROTTLE = 10 * 60 * 1_000   // 10 minutes

/** True only in production, non-E2E runs. */
function shouldCheck(): boolean {
  return app.isPackaged && !process.env.BABYDIARY_TEST_USERDATA
}

function getWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  return wins.length > 0 ? wins[0] : null
}

// P22: Module-level timer handles so stopUpdater() can cancel them.
let _initialTimeout: ReturnType<typeof setTimeout> | null = null
let _intervalHandle: ReturnType<typeof setInterval> | null = null

// In-flight guard: true while a checkForUpdates() promise is pending.
let _checking = false

// Timestamp of the last focus-triggered check (ms since epoch, 0 = never).
let _lastFocusCheck = 0

// Focus listener reference so we can remove it in stopUpdater().
let _focusListener: (() => void) | null = null
let _focusWindow: BrowserWindow | null = null

/** P22: Returns true if the periodic updater interval is currently active. */
export function isUpdaterRunning(): boolean {
  return _intervalHandle !== null
}

/** P22: Stop the updater timers (idempotent — safe when never started). */
export function stopUpdater(): void {
  if (_initialTimeout !== null) {
    clearTimeout(_initialTimeout)
    _initialTimeout = null
  }
  if (_intervalHandle !== null) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
  }
  if (_focusListener !== null && _focusWindow !== null) {
    _focusWindow.removeListener('focus', _focusListener)
    _focusListener = null
    _focusWindow = null
  }
}

export function setupUpdater(): void {
  if (!shouldCheck()) return
  // P22: Idempotent — skip if already running (e.g. after activate re-call).
  if (_intervalHandle !== null) return

  const isMac = process.platform === 'darwin'

  // Configure feed
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'HB-code-glitch',
    repo: 'baby-diary-releases',
  } as Parameters<typeof autoUpdater.setFeedURL>[0])

  autoUpdater.autoDownload = !isMac   // Windows: auto; macOS: manual (unsigned)
  autoUpdater.autoInstallOnAppQuit = false

  // ── Event handlers ──────────────────────────────────────────────────────────

  autoUpdater.on('update-available', (info) => {
    const win = getWindow()
    if (!win) return
    if (isMac) {
      // macOS unsigned: only notify, let user download from browser
      win.webContents.send('update:available', {
        version: info.version,
        url: DOWNLOAD_PAGE,
      })
    }
    // Windows: autoDownload is true — wait for update-downloaded
  })

  autoUpdater.on('update-downloaded', (info) => {
    if (isMac) return  // Should not occur (autoDownload=false on mac), but guard anyway
    const win = getWindow()
    if (!win) return
    win.webContents.send('update:ready', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    console.error('[Updater] error:', err?.message ?? err)
  })

  // ── IPC handlers ─────────────────────────────────────────────────────────────

  ipcMain.on('update:install', () => {
    if (isMac) return  // No quitAndInstall path on mac
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      console.error('[Updater] quitAndInstall error:', err)
    }
  })

  ipcMain.on('update:openDownload', () => {
    shell.openExternal(DOWNLOAD_PAGE).catch(err =>
      console.error('[Updater] openExternal error:', err)
    )
  })

  // ── Core check runner ────────────────────────────────────────────────────────

  function runCheck(trigger: 'start' | 'interval' | 'focus'): void {
    if (_checking) {
      console.log(`[Updater] check skipped (in-flight) — trigger: ${trigger}`)
      return
    }
    console.log(`[Updater] checking for updates — trigger: ${trigger}`)
    _checking = true
    autoUpdater.checkForUpdates()
      .catch(err => console.error('[Updater] checkForUpdates error:', err?.message ?? err))
      .finally(() => { _checking = false })
  }

  // ── Scheduled checks ────────────────────────────────────────────────────────

  // First check: 15 s after ready (app already emitted ready when this runs).
  // P22: store handle so stopUpdater() can cancel it.
  _initialTimeout = setTimeout(() => runCheck('start'), 15_000)

  // Subsequent checks: every 30 minutes.
  // P22: store handle so stopUpdater() can cancel it.
  _intervalHandle = setInterval(() => runCheck('interval'), INTERVAL_MS)

  // ── Focus-triggered check ────────────────────────────────────────────────────
  // Attach to the main window once it exists.  attachFocusListener() is called
  // from main.ts after createWindow(), and again from setupUpdater() if the
  // window already exists at the time setupUpdater() runs (e.g. activate path).

  function onWindowFocus(): void {
    const now = Date.now()
    if (now - _lastFocusCheck < FOCUS_THROTTLE) {
      console.log('[Updater] focus check throttled — skipping')
      return
    }
    _lastFocusCheck = now
    runCheck('focus')
  }

  // If a window is already open (activate path), attach immediately.
  const existingWin = getWindow()
  if (existingWin) {
    _focusListener = onWindowFocus
    _focusWindow = existingWin
    existingWin.on('focus', onWindowFocus)
  } else {
    // Otherwise, wait for the app 'browser-window-created' event to attach.
    app.once('browser-window-created', (_event, win) => {
      if (_intervalHandle === null) return  // stopUpdater() was already called
      _focusListener = onWindowFocus
      _focusWindow = win
      win.on('focus', onWindowFocus)
    })
  }
}
