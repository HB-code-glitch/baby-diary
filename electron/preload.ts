import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  BabyInfoCommitIpcResponse,
  BabyInfoSettingsCommitOperation,
  BabyInfoJournalSummary,
  BabyInfoMutation,
  BabyInfoPendingPage,
  BabyInfoPendingPageRequest,
  DataInfo,
  DiaryEvent,
  ExportFormat,
  FirebaseEmulatorBridge,
  SavePdfResult,
} from '../shared/types'
import type { HealthEvidenceSourceId } from '../shared/healthEvidence'
import type {
  BabyInfoArchivePage,
  BabyInfoArchivePageRequest,
} from '../shared/babyInfoArchivePaging'
import type {
  FirebaseConfig,
  FirebasePersistenceClaim,
} from '../shared/firebasePersistence'

// Sandboxed preload scripts cannot require local runtime modules. Keep this
// channel literal in sync with electron/evidenceExternalLink.ts; the contract
// test drives the exposed API through the registered main handler.
const EVIDENCE_SOURCE_OPEN_CHANNEL = 'evidence:openSource' as const
const ARCHIVE_PAGE_MAX = 50
const ARCHIVE_CURSOR_PATTERN = /^baby-info-archive-page-v1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ARCHIVE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FIREBASE_APP_NAME_PATTERN = /^baby-diary(?:-[a-f0-9]{64})?$/
const FIREBASE_CONFIG_FIELDS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
] as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseFirebaseConfig(value: unknown): FirebaseConfig {
  if (!isPlainRecord(value)
    || Object.keys(value).sort().join(',') !== [...FIREBASE_CONFIG_FIELDS].sort().join(',')) {
    throw new Error('Firebase configuration shape is invalid')
  }
  for (const field of FIREBASE_CONFIG_FIELDS) {
    const item = value[field]
    if (typeof item !== 'string' || item.length === 0 || item.length > 4_096 || item.includes('\0')) {
      throw new Error(`Firebase configuration field ${field} is invalid`)
    }
  }
  return Object.fromEntries(
    FIREBASE_CONFIG_FIELDS.map(field => [field, value[field]]),
  ) as unknown as FirebaseConfig
}

function parseFirebaseClaim(value: unknown, config: FirebaseConfig): FirebasePersistenceClaim {
  const configIdentity = JSON.stringify(Object.fromEntries(
    FIREBASE_CONFIG_FIELDS.map(field => [field, config[field]]),
  ))
  if (!isPlainRecord(value)
    || Object.keys(value).sort().join(',') !== 'appName,configIdentity,version'
    || value.version !== 1
    || value.configIdentity !== configIdentity
    || typeof value.appName !== 'string'
    || !FIREBASE_APP_NAME_PATTERN.test(value.appName)) {
    throw new Error('Firebase persistence claim response is invalid')
  }
  return {
    version: 1,
    configIdentity,
    appName: value.appName,
  }
}

function parseArchivePageRequest(value: unknown): BabyInfoArchivePageRequest {
  if (!isPlainRecord(value)
    || Object.keys(value).some(key => key !== 'limit' && key !== 'cursor')
    || !Number.isInteger(value.limit)
    || (value.limit as number) < 1
    || (value.limit as number) > ARCHIVE_PAGE_MAX
    || (value.cursor !== undefined
      && (typeof value.cursor !== 'string' || !ARCHIVE_CURSOR_PATTERN.test(value.cursor)))) {
    throw new Error('baby info archive page request is invalid')
  }
  return {
    limit: value.limit as number,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
  }
}

function parseArchivePageResponse(value: unknown): BabyInfoArchivePage {
  if (!isPlainRecord(value)
    || Object.keys(value).some(key => key !== 'items' && key !== 'nextCursor')
    || !Array.isArray(value.items)
    || value.items.length > ARCHIVE_PAGE_MAX
    || (value.nextCursor !== undefined
      && (typeof value.nextCursor !== 'string' || !ARCHIVE_CURSOR_PATTERN.test(value.nextCursor)))) {
    throw new Error('baby info archive page response is invalid')
  }
  const items = value.items.map(item => {
    if (!isPlainRecord(item)
      || Object.keys(item).sort().join(',') !== 'archiveId,archivedAt,babyBirthdate,babyName,source'
      || typeof item.archiveId !== 'string'
      || !ARCHIVE_ID_PATTERN.test(item.archiveId)
      || typeof item.babyName !== 'string'
      || typeof item.babyBirthdate !== 'string'
      || typeof item.archivedAt !== 'string'
      || !Number.isFinite(Date.parse(item.archivedAt))
      || item.source !== 'legacy-unscoped') {
      throw new Error('baby info archive page response is invalid')
    }
    return {
      archiveId: item.archiveId,
      babyName: item.babyName,
      babyBirthdate: item.babyBirthdate,
      archivedAt: item.archivedAt,
      source: 'legacy-unscoped' as const,
    }
  })
  return {
    items,
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor as string }),
  }
}

const babyDiaryAPI = {
  getFirebaseEmulator: (): Promise<FirebaseEmulatorBridge | null> =>
    ipcRenderer.invoke('test:firebaseEmulator'),

  claimFirebasePersistence: async (rawConfig: FirebaseConfig): Promise<FirebasePersistenceClaim> => {
    const config = parseFirebaseConfig(rawConfig)
    const response: unknown = await ipcRenderer.invoke('firebase:claimPersistence', config)
    return parseFirebaseClaim(response, config)
  },

  openEvidenceSource: (sourceId: HealthEvidenceSourceId): Promise<void> =>
    ipcRenderer.invoke(EVIDENCE_SOURCE_OPEN_CHANNEL, sourceId),

  listEvents: (): Promise<DiaryEvent[]> =>
    ipcRenderer.invoke('events:list'),

  listEventMutations: (): Promise<DiaryEvent[]> =>
    ipcRenderer.invoke('events:listMutations'),

  appendEvent: (event: DiaryEvent): Promise<'ok' | 'duplicate' | 'error'> =>
    ipcRenderer.invoke('events:append', event),

  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:get'),

  saveSettings: (settings: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', settings),

  mergeSettings: (partial: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:merge', partial),

  commitBabyInfo: (operation: BabyInfoSettingsCommitOperation): Promise<BabyInfoCommitIpcResponse> =>
    ipcRenderer.invoke('settings:commitBabyInfo', operation),

  listPendingBabyInfo: (request: BabyInfoPendingPageRequest): Promise<BabyInfoPendingPage> =>
    ipcRenderer.invoke('babyInfo:listPending', request),

  getBabyInfoSummary: (familyId: string): Promise<BabyInfoJournalSummary> =>
    ipcRenderer.invoke('babyInfo:getSummary', familyId),

  getBabyInfoMutation: (familyId: string, key: string): Promise<BabyInfoMutation | undefined> =>
    ipcRenderer.invoke('babyInfo:getMutation', familyId, key),

  listUnlinkedBabyInfoArchives: async (
    request: BabyInfoArchivePageRequest,
  ): Promise<BabyInfoArchivePage> => {
    const parsedRequest = parseArchivePageRequest(request)
    const response: unknown = await ipcRenderer.invoke('babyInfo:listUnlinkedArchives', parsedRequest)
    return parseArchivePageResponse(response)
  },

  exportData: (format: ExportFormat): Promise<void> =>
    ipcRenderer.invoke('data:export', format),

  openBackupFolder: (): Promise<void> =>
    ipcRenderer.invoke('data:openBackupFolder'),

  getDataInfo: (): Promise<DataInfo> =>
    ipcRenderer.invoke('data:getInfo'),

  onEventAppended: (callback: (event: DiaryEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: DiaryEvent) => callback(event)
    ipcRenderer.on('event:appended', handler)
    return () => ipcRenderer.removeListener('event:appended', handler)
  },

  onSettingsChanged: (callback: (payload: { sequence: number; settings: AppSettings }) => void): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      payload: { sequence: number; settings: AppSettings },
    ) => callback(payload)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.removeListener('settings:changed', handler)
  },

  // ── Auto-update ────────────────────────────────────────────────────────────

  /** Automatic mode: called when the installer is downloaded and ready to apply. */
  onUpdateReady: (callback: (payload: { version: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { version: string }) => callback(payload)
    ipcRenderer.on('update:ready', handler)
    return () => ipcRenderer.removeListener('update:ready', handler)
  },

  /** Manual mode: called when a new version is available on GitHub Releases. */
  onUpdateAvailable: (callback: (payload: { version: string; url: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { version: string; url: string }) => callback(payload)
    ipcRenderer.on('update:available', handler)
    return () => ipcRenderer.removeListener('update:available', handler)
  },

  /** Signal that the renderer installed both update listeners. */
  updateRendererReady: (): void => {
    ipcRenderer.send('update:rendererReady')
  },

  /** Automatic mode: quit and apply the downloaded update. */
  installUpdate: (): void => {
    ipcRenderer.send('update:install')
  },

  /** Manual mode: open the GitHub Releases page in the default browser. */
  openUpdateDownload: (): void => {
    ipcRenderer.send('update:openDownload')
  },

  savePdf: (): Promise<SavePdfResult> =>
    ipcRenderer.invoke('report:savePdf'),

  /** MF-06: renderer sends this after init() + ReportView render completes */
  reportReady: (): void => {
    ipcRenderer.send('report:ready')
  },
}

contextBridge.exposeInMainWorld('babyDiary', babyDiaryAPI)
