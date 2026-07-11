import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { EventLog } from './store/eventLog'
import { SettingsStore } from './store/settings'
import { BackupManager } from './store/backup'
import { DiaryEvent, AppSettings, ExportFormat } from '../shared/types'

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged

// 데이터 경로 영구 고정: 앱 이름/버전이 바뀌어도 기존 기록(%APPDATA%\baby-diary)을 계속 사용한다.
// 이 줄을 바꾸면 부모가 쌓아온 기록 폴더와 연결이 끊긴다 — 절대 수정 금지.
app.setPath('userData', path.join(app.getPath('appData'), 'baby-diary'))

// F3: Prevent concurrent instances from writing to the same JSONL files simultaneously.
// requestSingleInstanceLock() is synchronous and must be called before app is ready.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Another instance is already running; quit immediately.
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let eventLog: EventLog
let settingsStore: SettingsStore
let backupManager: BackupManager

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Baby Diary',
    show: false,
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupIPC(): void {
  ipcMain.handle('events:list', async () => {
    return eventLog.loadAll()
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
    settingsStore.save(settings)
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
}

// F3: When a second instance tries to launch, focus/restore the existing window.
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData')

  eventLog = new EventLog({ dataDir: path.join(userDataPath, 'data') })
  settingsStore = new SettingsStore(userDataPath)
  backupManager = new BackupManager(userDataPath)

  eventLog.loadAll()

  setupIPC()
  createWindow()
  backupManager.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// V3: best-effort backup on quit (covers Cmd+Q, system shutdown, etc.)
app.on('before-quit', () => {
  try {
    backupManager.backup().catch(err =>
      console.error('[Backup] before-quit backup failed:', err)
    )
  } catch (err) {
    console.error('[Backup] before-quit backup error:', err)
  }
})

app.on('window-all-closed', () => {
  backupManager.stop()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
