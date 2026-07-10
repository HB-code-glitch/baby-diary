import { contextBridge, ipcRenderer } from 'electron'
import { DiaryEvent, AppSettings, DataInfo, ExportFormat } from '../shared/types'

const babyDiaryAPI = {
  listEvents: (): Promise<DiaryEvent[]> =>
    ipcRenderer.invoke('events:list'),

  appendEvent: (event: DiaryEvent): Promise<boolean> =>
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
}

contextBridge.exposeInMainWorld('babyDiary', babyDiaryAPI)
