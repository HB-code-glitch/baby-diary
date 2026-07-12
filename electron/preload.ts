import { contextBridge, ipcRenderer } from 'electron'
import { DiaryEvent, AppSettings, DataInfo, ExportFormat, SavePdfResult } from '../shared/types'

const babyDiaryAPI = {
  listEvents: (): Promise<DiaryEvent[]> =>
    ipcRenderer.invoke('events:list'),

  appendEvent: (event: DiaryEvent): Promise<'ok' | 'duplicate' | 'error'> =>
    ipcRenderer.invoke('events:append', event),

  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:get'),

  saveSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke('settings:save', settings),

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

  /** Windows: called when installer is downloaded and ready to apply. */
  onUpdateReady: (callback: (payload: { version: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { version: string }) => callback(payload)
    ipcRenderer.on('update:ready', handler)
    return () => ipcRenderer.removeListener('update:ready', handler)
  },

  /** macOS: called when a new version is available on GitHub Releases. */
  onUpdateAvailable: (callback: (payload: { version: string; url: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { version: string; url: string }) => callback(payload)
    ipcRenderer.on('update:available', handler)
    return () => ipcRenderer.removeListener('update:available', handler)
  },

  /** Windows: quit and apply the downloaded update. */
  installUpdate: (): void => {
    ipcRenderer.send('update:install')
  },

  /** macOS: open the GitHub Releases page in the default browser. */
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
