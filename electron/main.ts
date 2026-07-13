import { app, BrowserWindow, ipcMain, dialog, session, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { pathToFileURL } from 'url'
import { EventLog } from './store/eventLog'
import { SettingsStore } from './store/settings'
import { BackupManager } from './store/backup'
import type {
  AppSettings,
  BabyInfoCommitIpcResponse,
  BabyInfoSettingsCommitOperation,
  DiaryEvent,
  ExportFormat,
  SavePdfResult,
} from '../shared/types'
import { BabyInfoSettingsCommitError } from '../shared/babyInfoSettingsCommit'
import { attachUpdaterWindow, setupUpdater, stopUpdater, isUpdaterRunning } from './updater'
import { registerEvidenceExternalLinkIPC } from './evidenceExternalLink'
import { hardenBrowserWindow } from './windowSecurity'
import { readFirebaseEmulatorBridge } from './firebaseEmulatorConfig'
import { createSyncE2EGuard, readSyncE2EGuardConfig } from './syncE2EGuard'

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged
const rendererEntryPath = path.join(__dirname, '../../dist/index.html')
const rendererEntryUrl = isDev
  ? 'http://localhost:5173/'
  : pathToFileURL(rendererEntryPath).toString()

// E2E 전용: 환경변수가 설정된 경우 임시 디렉토리를 userData로 사용한다 (실 데이터 오염 방지).
if (process.env.BABYDIARY_TEST_USERDATA) {
  app.setPath('userData', process.env.BABYDIARY_TEST_USERDATA)
} else {
  // 데이터 경로 영구 고정: 앱 이름/버전이 바뀌어도 기존 기록(%APPDATA%\baby-diary)을 계속 사용한다.
  // 이 줄을 바꾸면 부모가 쌓아온 기록 폴더와 연결이 끊긴다 — 절대 수정 금지.
  app.setPath('userData', path.join(app.getPath('appData'), 'baby-diary'))
}

// Test-only Firebase endpoints are parsed in the main process. The sandboxed
// preload cannot import local runtime helpers, so it forwards this value over
// a fixed IPC channel. Non-isolated production runs always receive null.
const firebaseEmulatorBridge = readFirebaseEmulatorBridge(process.env)
const syncE2EGuardConfig = readSyncE2EGuardConfig(process.env, app.getPath('userData'))
const syncE2EGuard = syncE2EGuardConfig ? createSyncE2EGuard(syncE2EGuardConfig) : null
const rendererResourceRoot = path.dirname(rendererEntryPath)

// F3: Prevent concurrent instances from writing to the same JSONL files simultaneously.
// requestSingleInstanceLock() is synchronous and must be called before app is ready.
// P26: Skip the lock when running under E2E test env so prod and test can coexist.
if (!process.env.BABYDIARY_TEST_USERDATA) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    // Another instance is already running; quit immediately.
    app.quit()
  }
}

let mainWindow: BrowserWindow | null = null
let eventLog: EventLog
let settingsStore: SettingsStore
let backupManager: BackupManager
let settingsChangeSequence = 0

function publishAuthoritativeSettings(settings: AppSettings): void {
  if (!mainWindow) return
  settingsChangeSequence += 1
  mainWindow.webContents.send('settings:changed', {
    sequence: settingsChangeSequence,
    settings,
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Baby Diary',
    show: false,
  })
  syncE2EGuard?.attachWindowDiagnostics(mainWindow, rendererResourceRoot)
  hardenBrowserWindow(mainWindow, rendererEntryUrl)

  attachUpdaterWindow(mainWindow)

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(rendererEntryPath)
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupIPC(): void {
  registerEvidenceExternalLinkIPC(ipcMain, url => shell.openExternal(url))

  ipcMain.handle('test:firebaseEmulator', async () => firebaseEmulatorBridge)

  // P20: Use cached getAll() instead of loadAll() on every IPC call.
  // loadAll() clears the index and re-scans disk — O(N) I/O per reconcile.
  // getAll() returns the in-memory index (O(1)) which is always up-to-date after append().
  ipcMain.handle('events:list', async () => {
    return eventLog.getAll()
  })

  ipcMain.handle('events:listMutations', async () => {
    return eventLog.getAllMutations()
  })

  ipcMain.handle('events:append', async (_, event: DiaryEvent) => {
    const result = eventLog.append(event)
    // Broadcast to renderer only on a genuinely new write (not duplicate/error)
    if (result === 'ok' && mainWindow) {
      mainWindow.webContents.send('event:appended', event)
    }
    // Return tri-state string; preload passes it through to renderer
    return result
  })

  ipcMain.handle('settings:get', async () => {
    return settingsStore.get()
  })

  ipcMain.handle('settings:save', async (_, settings: AppSettings) => {
    const saved = settingsStore.save(settings)
    publishAuthoritativeSettings(saved)
    return saved
  })

  ipcMain.handle('settings:merge', async (_, partial: Partial<AppSettings>) => {
    const saved = settingsStore.merge(partial)
    publishAuthoritativeSettings(saved)
    return saved
  })

  ipcMain.handle('babyInfo:listPending', async (_, request: unknown) => {
    return settingsStore.listPendingBabyInfo(request)
  })

  ipcMain.handle('babyInfo:getSummary', async (_, familyId: string) => {
    return settingsStore.getBabyInfoSummary(familyId)
  })

  ipcMain.handle('settings:commitBabyInfo', async (
    _,
    operation: BabyInfoSettingsCommitOperation,
  ): Promise<BabyInfoCommitIpcResponse> => {
    try {
      const value = settingsStore.commitBabyInfo(operation)
      publishAuthoritativeSettings(value.settings)
      return { ok: true, value }
    } catch (error) {
      if (error instanceof BabyInfoSettingsCommitError) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.code === 'FAMILY_MISMATCH'
              ? 'Baby info family changed. Refresh and try again.'
              : 'Invalid baby info operation.',
          },
        }
      }
      const storageFailure = error instanceof Error && error.message.startsWith('[Settings] save failed:')
      return {
        ok: false,
        error: {
          code: storageFailure ? 'STORAGE_FAILURE' : 'INTERNAL_ERROR',
          message: storageFailure
            ? 'Unable to save baby info settings.'
            : 'Unable to commit baby info settings.',
        },
      }
    }
  })

  ipcMain.handle('data:export', async (_, format: ExportFormat) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '내보낼 폴더 선택 / エクスポート先フォルダを選択',
    })

    if (canceled || !filePaths[0]) return

    const destDir = filePaths[0]
    const events = eventLog.loadAll().filter(e => !e.deleted)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

    if (format === 'json') {
      const filePath = path.join(destDir, `baby-diary-${timestamp}.json`)
      const content = JSON.stringify(events, null, 2)
      // V6: fd + fsyncSync before close for durability
      const fd = fs.openSync(filePath, 'w')
      try {
        fs.writeSync(fd, content, 0, 'utf-8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    } else if (format === 'csv') {
      const filePath = path.join(destDir, `baby-diary-${timestamp}.csv`)
      // Bilingual headers: Korean/Japanese so both parents can read the export
      const headers = [
        'id',
        'type/種別',
        'at/日時',
        'data/データ',
        'author_uid/記録者ID',
        'author_name/記録者名',
        'author_role/役割',
        'createdAt/作成日時',
        'updatedAt/更新日時',
        'rev/リビジョン',
      ]
      const rows = events.map(e => [
        e.id,
        e.type,
        e.at,
        JSON.stringify(e.data),
        e.author.uid,
        e.author.name,
        e.author.role,
        e.createdAt,
        e.updatedAt,
        e.rev,
      ])
      const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
      const csvContent = '﻿' + csv // BOM for Excel compatibility
      // V6: fd + fsyncSync before close for durability
      const fd = fs.openSync(filePath, 'w')
      try {
        fs.writeSync(fd, csvContent, 0, 'utf-8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    }
  })

  ipcMain.handle('data:openBackupFolder', async () => {
    const backupDir = backupManager.getBackupDir()
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true })
    }
    shell.openPath(backupDir)
  })

  ipcMain.handle('data:getInfo', async () => {
    const userDataPath = app.getPath('userData')
    const dataDir = path.join(userDataPath, 'data')
    return {
      dataDir,
      backupDir: backupManager.getBackupDir(),
      documentsBackupDir: backupManager.getDocumentsBackupDir(),
      eventCount: eventLog.getCount(),
      lastBackupTime: backupManager.getLastBackupTime(),
    }
  })

  ipcMain.handle('report:savePdf', async (): Promise<SavePdfResult> => {
    if (!mainWindow) return { saved: false }

    // 1. Show save dialog first so user picks a path before rendering
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '검진 리포트 저장 / 健診レポート保存',
      defaultPath: `baby-report-${new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (canceled || !filePath) return { saved: false }

    // 2. Create a hidden BrowserWindow that loads the report route
    const printWin = new BrowserWindow({
      width: 900,
      height: 1200,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    syncE2EGuard?.attachWindowDiagnostics(printWin, rendererResourceRoot)
    hardenBrowserWindow(printWin, rendererEntryUrl)

    try {
      // 3. Load the same app at #/report -- shares the same preload+store hydration
      if (isDev) {
        await printWin.loadURL('http://localhost:5173/#/report')
      } else {
        await printWin.loadFile(rendererEntryPath, { hash: '/report' })
      }

      // 4. MF-06: wait for report:ready IPC from renderer (store init + render done)
      //    with a 5s timeout fallback in case the signal never arrives.
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 5000)
        ipcMain.once('report:ready', () => {
          clearTimeout(timer)
          resolve()
        })
      })

      // 5. Print to PDF
      const pdfBuffer = await printWin.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
      })

      // 6. Write with fd+fsync for durability
      const fd = fs.openSync(filePath, 'w')
      try {
        fs.writeSync(fd, pdfBuffer)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }

      return { saved: true, path: filePath }
    } finally {
      printWin.destroy()
    }
  })
}

// F3: When a second instance tries to launch, focus/restore the existing window.
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  syncE2EGuard?.installSessionGuard(session.defaultSession, rendererResourceRoot)
  const userDataPath = app.getPath('userData')

  eventLog = new EventLog({ dataDir: path.join(userDataPath, 'data') })
  settingsStore = new SettingsStore(userDataPath)
  backupManager = new BackupManager(userDataPath)

  // P20: Explicit startup scan so index is warm before any IPC arrives.
  // After this, getAll() is used for 'events:list' (no re-scan per call).
  eventLog.loadAll()

  setupIPC()
  setupUpdater()
  createWindow()
  backupManager.start()

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow()
      // P21: If the backup timer was stopped by window-all-closed (non-darwin
      // doesn't reach here, but on macOS it does), restart it so the 6-hour
      // cycle resumes after dock-reopen.
      if (!backupManager.isRunning()) backupManager.start()
      // P22: Restart updater timer if stopped (idempotent — no-op if already running).
      setupUpdater()
    }
  })
})

app.on('will-quit', () => {
  syncE2EGuard?.close()
})

// P9 + V3: defer quit until backup() has fully settled so a crash mid-backup
// cannot leave a corrupt or partial backup file as the newest copy.
app.on('before-quit', (event) => {
  event.preventDefault()
  // P22: Stop the updater timer so it cannot fire during shutdown.
  stopUpdater()
  backupManager.backup()
    .catch(err => console.error('[Backup] before-quit failed:', err))
    .finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  // P21: Only stop the backup timer on non-darwin. On macOS, the app stays
  // alive when all windows close (dock icon remains) and backup should
  // continue running. Stopping it here would leave the macOS session without
  // a backup timer until the next dock-reopen (handled in activate above).
  if (process.platform !== 'darwin') {
    backupManager.stop()
    app.quit()
  }
})
