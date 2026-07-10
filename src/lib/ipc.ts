import { DiaryEvent, AppSettings, DataInfo, ExportFormat } from '../../shared/types'

declare global {
  interface Window {
    babyDiary: {
      listEvents: () => Promise<DiaryEvent[]>
      appendEvent: (event: DiaryEvent) => Promise<boolean>
      getSettings: () => Promise<AppSettings>
      saveSettings: (settings: AppSettings) => Promise<void>
      exportData: (format: ExportFormat) => Promise<void>
      openBackupFolder: () => Promise<void>
      getDataInfo: () => Promise<DataInfo>
      onEventAppended: (callback: (event: DiaryEvent) => void) => () => void
    }
  }
}

export const ipc = {
  listEvents: (): Promise<DiaryEvent[]> => window.babyDiary.listEvents(),
  appendEvent: (event: DiaryEvent): Promise<boolean> => window.babyDiary.appendEvent(event),
  getSettings: (): Promise<AppSettings> => window.babyDiary.getSettings(),
  saveSettings: (settings: AppSettings): Promise<void> => window.babyDiary.saveSettings(settings),
  exportData: (format: ExportFormat): Promise<void> => window.babyDiary.exportData(format),
  openBackupFolder: (): Promise<void> => window.babyDiary.openBackupFolder(),
  getDataInfo: (): Promise<DataInfo> => window.babyDiary.getDataInfo(),
  onEventAppended: (callback: (event: DiaryEvent) => void): (() => void) =>
    window.babyDiary.onEventAppended(callback),
}
