import { app, BrowserWindow, ipcMain, dialog, session, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { pathToFileURL } from 'url'
import { EventLog } from './store/eventLog'
import { SettingsStore } from './store/settings'
import { BackupManager } from './store/backup'
import { SettingsRecoveryError } from './store/backupSnapshot'
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
import {
  FirebasePersistenceRegistry,
  detectPreexistingFirebaseProfile,
} from './store/firebasePersistenceRegistry'
import { registerFirebasePersistenceIPC } from './firebasePersistenceIPC'

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
let firebasePersistenceRegistry: FirebasePersistenceRegistry
let settingsChangeSequence = 0
let runtimeRecoveryLocked = false

type StartupRecoveryEvidence = {
  originalsPreserved?: unknown
  restartRequired?: unknown
  restoreApplied?: unknown
  recoveryFollowUpRequired?: unknown
  primaryUntouched?: unknown
  localDataModified?: unknown
  archiveEvidence?: { archiveId?: unknown; durable?: unknown }
  journalEvidence?: {
    kind?: unknown
    durable?: unknown
    committed?: unknown
    uncertain?: unknown
  }
  settingsEvidence?: { committed?: unknown; durabilityConfirmed?: unknown }
}

function startupFailureMessage(error: unknown, recoveryRequired: boolean): string {
  const evidence = error && typeof error === 'object'
    ? error as StartupRecoveryEvidence
    : {}
  const originalsPreserved = recoveryRequired && evidence.originalsPreserved === true
  const restartRequired = recoveryRequired && evidence.restartRequired === true
  const restoreApplied = recoveryRequired
    && restartRequired
    && evidence.restoreApplied === true
  const primaryUntouched = recoveryRequired && evidence.primaryUntouched === true
  const recoveryFollowUpRequired = recoveryRequired
    && evidence.recoveryFollowUpRequired === true
    && evidence.restoreApplied === true
    && evidence.localDataModified === true
    && !restartRequired
    && !primaryUntouched
  const durableLocalArchive = recoveryRequired
    && evidence.localDataModified === true
    && evidence.archiveEvidence?.durable === true
    && typeof evidence.archiveEvidence.archiveId === 'string'
  const journalKind = typeof evidence.journalEvidence?.kind === 'string'
    ? evidence.journalEvidence.kind
    : undefined
  const durableLocalJournalMigration = recoveryRequired
    && evidence.localDataModified === true
    && evidence.journalEvidence?.durable === true
    && (journalKind === 'legacy-import' || journalKind === 'legacy-local-pair')
  const committedLocalJournal = recoveryRequired
    && evidence.localDataModified === true
    && journalKind === 'storage-uncertain'
    && evidence.journalEvidence?.durable === true
    && evidence.journalEvidence?.committed === true
    && evidence.journalEvidence?.uncertain === true
  const uncertainLocalJournal = recoveryRequired
    && evidence.localDataModified === true
    && journalKind === 'storage-uncertain'
    && evidence.journalEvidence?.uncertain === true
    && !committedLocalJournal
  const committedLocalSettings = recoveryRequired
    && evidence.localDataModified === true
    && evidence.settingsEvidence?.committed === true
    && evidence.settingsEvidence?.durabilityConfirmed === false

  if (restoreApplied) {
    return [
      'A verified settings and baby journal pair was applied locally. Baby Diary did not open the app UI. Restart Baby Diary once more so an independent startup can verify the restored pair. Cloud synchronization was not started in this launch.',
      '검증된 설정 및 아기 기록 쌍이 로컬에 적용되었습니다. 앱 화면은 열리지 않았습니다. 별도의 시작 과정에서 복원된 쌍을 확인할 수 있도록 Baby Diary를 한 번 더 다시 시작해 주세요. 이번 실행에서는 클라우드 동기화가 시작되지 않았습니다.',
      '検証済みの設定と赤ちゃん記録のペアをローカルに適用しました。アプリ画面は開いていません。別の起動で復元済みペアを確認するため、Baby Diaryをもう一度再起動してください。この起動ではクラウド同期は開始されていません。',
    ].join('\n\n')
  }
  if (recoveryFollowUpRequired) {
    return [
      'A previously verified restore was applied, but the current local settings/journal pair or its recovery evidence no longer verifies. Recovery transaction and forensic follow-up data remain for support inspection. Restarting alone will not repair damaged data; contact support before making further local changes. Cloud synchronization was not started in this launch.',
      '이전에 검증된 복원이 적용되었지만 현재 로컬 설정/기록 쌍 또는 복구 증거를 더 이상 검증할 수 없습니다. 지원 확인을 위한 복구 트랜잭션과 포렌식 후속 자료는 남아 있습니다. 다시 시작하는 것만으로는 손상된 데이터를 복구할 수 없으므로 추가 로컬 변경 전에 지원팀에 문의해 주세요. 이번 실행에서는 클라우드 동기화가 시작되지 않았습니다.',
      '以前に検証済みの復元が適用されましたが、現在のローカル設定・記録ペアまたは復旧証拠を検証できなくなりました。サポート確認用の復旧トランザクションとフォレンジック追跡資料は残っています。再起動するだけでは破損データは修復されないため、追加のローカル変更を行う前にサポートへ連絡してください。この起動ではクラウド同期は開始されていません。',
    ].join('\n\n')
  }
  if (durableLocalArchive) {
    return [
      'A local baby-info archive was durably added before settings projection failed. No cloud data was changed. Restart Baby Diary so the saved archive can be reconciled.',
      '설정 반영에 실패하기 전에 로컬 아기 정보 보관본이 안전하게 저장되었습니다. 클라우드 데이터는 변경되지 않았습니다. 저장된 보관본을 정리하려면 아기 일기를 다시 시작해 주세요.',
      '設定への反映に失敗する前に、ローカルの赤ちゃん情報アーカイブが安全に保存されました。クラウドデータは変更されていません。保存済みアーカイブを整合するため、ベビーダイアリーを再起動してください。',
    ].join('\n\n')
  }
  if (committedLocalJournal) {
    return [
      'A local baby-info journal update reached local storage, but final file-handle confirmation failed. Journal bytes changed and must be revalidated before more work. The app UI did not open, and cloud synchronization was not started in this launch. Restart Baby Diary.',
      '로컬 아기 정보 기록 업데이트가 저장소에 반영되었지만 파일 핸들의 최종 확인에 실패했습니다. 기록 바이트가 변경되었으므로 추가 작업 전에 다시 검증해야 합니다. 앱 화면은 열리지 않았고 이번 실행에서는 클라우드 동기화가 시작되지 않았습니다. Baby Diary를 다시 시작해 주세요.',
      'ローカルの赤ちゃん情報記録の更新はストレージに反映されましたが、ファイルハンドルの最終確認に失敗しました。記録バイトは変更されているため、続行前に再検証が必要です。アプリ画面は開かれず、この起動ではクラウド同期も開始されていません。Baby Diaryを再起動してください。',
    ].join('\n\n')
  }
  if (uncertainLocalJournal) {
    return [
      'Local baby-info journal bytes may have changed, and final durability is unknown. The app UI did not open, and cloud synchronization was not started in this launch. Restart Baby Diary so local storage can be revalidated before any more changes.',
      '로컬 아기 정보 기록 바이트가 변경되었을 수 있으며 최종 내구성은 확인되지 않았습니다. 앱 화면은 열리지 않았고 이번 실행에서는 클라우드 동기화가 시작되지 않았습니다. 추가 변경 전에 로컬 저장소를 다시 검증할 수 있도록 Baby Diary를 다시 시작해 주세요.',
      'ローカルの赤ちゃん情報記録バイトが変更された可能性があり、最終的な耐久性は不明です。アプリ画面は開かれず、この起動ではクラウド同期も開始されていません。追加変更の前にローカルストレージを再検証するため、Baby Diaryを再起動してください。',
    ].join('\n\n')
  }
  if (durableLocalJournalMigration) {
    return [
      'A local baby-info journal migration was durably recorded before settings projection failed. No cloud data was changed. Restart Baby Diary so the saved journal can be reconciled.',
      '설정 반영에 실패하기 전에 로컬 아기 정보 기록 마이그레이션이 안전하게 저장되었습니다. 클라우드 데이터는 변경되지 않았습니다. 저장된 기록을 정리하려면 아기 일기를 다시 시작해 주세요.',
      '設定への反映に失敗する前に、ローカルの赤ちゃん情報記録の移行が安全に保存されました。クラウドデータは変更されていません。保存済みの記録を整合するため、Baby Diary を再起動してください。',
    ].join('\n\n')
  }
  if (committedLocalSettings) {
    return [
      'A settings replacement reached local storage, but final directory durability confirmation failed. Local data may have changed; no cloud data was changed. Restart Baby Diary before making more changes.',
      '설정 교체가 로컬 저장소에 반영되었지만 디렉터리 내구성의 최종 확인에 실패했습니다. 로컬 데이터가 변경되었을 수 있으며 클라우드 데이터는 변경되지 않았습니다. 추가 변경 전에 아기 일기를 다시 시작해 주세요.',
      '設定の置換はローカルストレージに反映されましたが、ディレクトリ永続性の最終確認に失敗しました。ローカルデータが変更された可能性がありますが、クラウドデータは変更されていません。追加の変更を行う前に Baby Diary を再起動してください。',
    ].join('\n\n')
  }
  if (originalsPreserved) {
    return [
      'Settings and baby journal could not be verified or restored from a verified backup. A durable forensic archive of the originals was confirmed for support recovery.',
      '설정과 아기 기록을 검증하거나 검증된 백업에서 복원하지 못했습니다. 지원 복구용 원본 보관본이 안전하게 보존된 것은 확인되었습니다.',
      '設定と赤ちゃん記録を検証できず、検証済みバックアップからも復元できませんでした。サポート復旧用の原本アーカイブが安全に保存されたことは確認済みです。',
    ].join('\n\n')
  }
  if (restartRequired && primaryUntouched) {
    return [
      'Recovery evidence was staged, and the primary settings and journal files remain untouched. Restart Baby Diary for independent verification. Durable preservation of the originals is not yet confirmed.',
      '복구 증거를 준비했으며 기본 설정 및 기록 파일은 변경하지 않았습니다. 독립 검증을 위해 아기 일기를 다시 시작해 주세요. 원본의 안전한 보존은 아직 확인되지 않았습니다.',
      '復旧証拠を準備し、主要な設定ファイルと記録ファイルには変更を加えていません。独立検証のためベビーダイアリーを再起動してください。原本の安全な保存はまだ確認されていません。',
    ].join('\n\n')
  }
  if (recoveryRequired) {
    return [
      'Settings and baby journal could not be verified or restored from a verified backup. Recovery stopped before overwrite, but durable preservation of the originals could not be confirmed.',
      '설정과 아기 기록을 검증하거나 검증된 백업에서 복원하지 못했습니다. 덮어쓰기 전에 복구를 중단했지만 원본의 안전한 보존은 확인되지 않았습니다.',
      '設定と赤ちゃん記録を検証できず、検証済みバックアップからも復元できませんでした。上書き前に復旧を停止しましたが、原本の安全な保存は確認できていません。',
    ].join('\n\n')
  }
  return [
    'Baby Diary could not start. No local data was modified after the startup failure.',
    '아기 일기를 시작할 수 없습니다. 시작 실패 이후 로컬 데이터는 변경되지 않았습니다.',
    'ベビーダイアリーを起動できませんでした。起動失敗後にローカルデータは変更されていません。',
  ].join('\n\n')
}

function isRecoveryRequiredError(error: unknown): boolean {
  return error instanceof SettingsRecoveryError
    || (typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'SETTINGS_RECOVERY_REQUIRED')
}

function runtimeRecoveryMessage(): string {
  return [
    'Local settings may already have changed, and final durability could not be confirmed. Further settings and baby-info changes, including cloud pending drain, are blocked. Baby Diary will close; restart it to revalidate local data. Cloud synchronization may already have been in progress.',
    '로컬 설정이 이미 변경되었을 수 있으며 최종 내구성을 확인하지 못했습니다. 클라우드 대기 항목 전송을 포함한 추가 설정 및 아기 정보 변경을 차단했습니다. 로컬 데이터를 다시 검증하기 위해 아기 일기를 종료하므로 다시 시작해 주세요. 클라우드 동기화가 이미 진행 중이었을 수 있습니다.',
    'ローカル設定はすでに変更されている可能性があり、最終的な永続性を確認できませんでした。クラウド保留項目の送信を含む設定・赤ちゃん情報の追加変更を停止しました。ローカルデータを再検証するため Baby Diary を終了します。再起動してください。クラウド同期がすでに進行していた可能性があります。',
  ].join('\n\n')
}

function recoveryRequiredIpcError(): Error & { code: 'RECOVERY_REQUIRED'; recoverable: true } {
  return Object.assign(new Error('Baby Diary must restart to revalidate local settings.'), {
    code: 'RECOVERY_REQUIRED' as const,
    recoverable: true as const,
  })
}

function enterRuntimeRecoveryLock(): void {
  if (runtimeRecoveryLocked) return
  runtimeRecoveryLocked = true
  dialog.showErrorBox('Baby Diary recovery required', runtimeRecoveryMessage())
  app.exit(1)
}

function assertRuntimeRecoveryUnlocked(): void {
  if (runtimeRecoveryLocked) throw recoveryRequiredIpcError()
}

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

  registerFirebasePersistenceIPC(
    ipcMain,
    firebasePersistenceRegistry,
    () => mainWindow,
  )

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
    try {
      assertRuntimeRecoveryUnlocked()
      const saved = settingsStore.save(settings)
      publishAuthoritativeSettings(saved)
      return saved
    } catch (error) {
      if (isRecoveryRequiredError(error)) {
        enterRuntimeRecoveryLock()
        throw recoveryRequiredIpcError()
      }
      throw error
    }
  })

  ipcMain.handle('settings:merge', async (_, partial: Partial<AppSettings>) => {
    try {
      assertRuntimeRecoveryUnlocked()
      const saved = settingsStore.merge(partial)
      publishAuthoritativeSettings(saved)
      return saved
    } catch (error) {
      if (isRecoveryRequiredError(error)) {
        enterRuntimeRecoveryLock()
        throw recoveryRequiredIpcError()
      }
      throw error
    }
  })

  ipcMain.handle('babyInfo:listPending', async (_, request: unknown) => {
    try {
      assertRuntimeRecoveryUnlocked()
      return settingsStore.listPendingBabyInfo(request)
    } catch (error) {
      if (isRecoveryRequiredError(error)) {
        enterRuntimeRecoveryLock()
        throw recoveryRequiredIpcError()
      }
      throw error
    }
  })

  ipcMain.handle('babyInfo:getSummary', async (_, familyId: string) => {
    return settingsStore.getBabyInfoSummary(familyId)
  })

  ipcMain.handle('babyInfo:getMutation', async (_, familyId: string, key: string) => {
    return settingsStore.getBabyInfoMutation(familyId, key)
  })

  ipcMain.handle('babyInfo:listUnlinkedArchives', async (_, request: unknown) => {
    return settingsStore.listUnlinkedBabyInfoArchives(request)
  })

  ipcMain.handle('settings:commitBabyInfo', async (
    _,
    operation: BabyInfoSettingsCommitOperation,
  ): Promise<BabyInfoCommitIpcResponse> => {
    try {
      assertRuntimeRecoveryUnlocked()
      const value = settingsStore.commitBabyInfo(operation)
      publishAuthoritativeSettings(value.settings)
      return { ok: true, value }
    } catch (error) {
      if (isRecoveryRequiredError(error)
        || (typeof error === 'object'
          && error !== null
          && (error as { code?: unknown }).code === 'RECOVERY_REQUIRED')) {
        enterRuntimeRecoveryLock()
        return {
          ok: false,
          error: {
            code: 'RECOVERY_REQUIRED',
            message: 'Baby Diary must restart to revalidate local settings.',
          },
        }
      }
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
  // Snapshot released-profile eligibility before current startup constructors can
  // create settings/journal/backup files. The immutable registry then prevents
  // every later restart from reclassifying a fresh profile as legacy.
  const firebaseProfileEligibility = detectPreexistingFirebaseProfile(userDataPath)
  backupManager = new BackupManager(userDataPath)
  if (firebaseProfileEligibility.kind === 'settings-invalid') {
    // SettingsStore owns verified pair recovery. On Windows it throws until the
    // independent restart protocol is fully complete, so no immutable Firebase
    // ownership can be published from damaged or half-restored settings.
    settingsStore = new SettingsStore(userDataPath, {
      documentsBackupDir: backupManager.getDocumentsBackupDir(),
    })
    firebasePersistenceRegistry = FirebasePersistenceRegistry.openAfterSettingsRecovery(
      userDataPath,
      firebaseProfileEligibility,
      settingsStore.get(),
    )
  } else {
    firebasePersistenceRegistry = FirebasePersistenceRegistry.open(
      userDataPath,
      firebaseProfileEligibility,
    )
    settingsStore = new SettingsStore(userDataPath, {
      documentsBackupDir: backupManager.getDocumentsBackupDir(),
    })
  }
  eventLog = new EventLog({ dataDir: path.join(userDataPath, 'data') })

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
}).catch(error => {
  const recoveryRequired = error instanceof SettingsRecoveryError
    || (error && typeof error === 'object'
      && (error as { code?: unknown }).code === 'SETTINGS_RECOVERY_REQUIRED')
  dialog.showErrorBox(
    recoveryRequired ? 'Baby Diary recovery required' : 'Baby Diary startup failed',
    startupFailureMessage(error, Boolean(recoveryRequired)),
  )
  app.exit(1)
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
