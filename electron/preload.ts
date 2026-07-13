import { contextBridge, ipcRenderer } from 'electron'
import type { DiaryEvent, AppSettings, DataInfo, ExportFormat, SavePdfResult, FirebaseEmulatorBridge } from '../shared/types'
import type { HealthEvidenceSourceId } from '../shared/healthEvidence'

// Sandboxed preload scripts cannot require local runtime modules. Keep this
// channel literal in sync with electron/evidenceExternalLink.ts; the contract
// test drives the exposed API through the registered main handler.
const EVIDENCE_SOURCE_OPEN_CHANNEL = 'evidence:openSource' as const

const babyDiaryAPI = {
  getFirebaseEmulator: (): Promise<FirebaseEmulatorBridge | null> =>
    ipcRenderer.invoke('test:firebaseEmulator'),

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

  saveSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke('settings:save', settings),

  mergeSettings: (partial: Partial<AppSettings>): Promise<void> =>
    ipcRenderer.invoke('settings:merge', partial),

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
