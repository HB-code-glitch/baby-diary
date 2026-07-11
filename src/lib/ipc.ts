import { DiaryEvent, AppSettings, DataInfo, ExportFormat, SavePdfResult } from '../../shared/types'

declare global {
  interface Window {
    babyDiary: {
      listEvents: () => Promise<DiaryEvent[]>
      appendEvent: (event: DiaryEvent) => Promise<'ok' | 'duplicate' | 'error'>
      getSettings: () => Promise<AppSettings>
      saveSettings: (settings: AppSettings) => Promise<void>
      exportData: (format: ExportFormat) => Promise<void>
      openBackupFolder: () => Promise<void>
      getDataInfo: () => Promise<DataInfo>
      onEventAppended: (callback: (event: DiaryEvent) => void) => () => void
      // Auto-update
      onUpdateReady: (callback: (payload: { version: string }) => void) => () => void
      onUpdateAvailable: (callback: (payload: { version: string; url: string }) => void) => () => void
      installUpdate: () => void
      openUpdateDownload: () => void
      savePdf: () => Promise<SavePdfResult>
    }
  }
}

// ────────────────────────────────────────────────────────────
// Browser / dev fallback mock (localStorage-backed)
// Used when window.babyDiary is not injected by Electron preload.
// ────────────────────────────────────────────────────────────

const MOCK_EVENTS_KEY = 'babydiary.mock.events'
const MOCK_SETTINGS_KEY = 'babydiary.mock.settings'

type EventCallback = (event: DiaryEvent) => void
const _mockListeners: EventCallback[] = []

function mockGetEvents(): DiaryEvent[] {
  try {
    const raw = localStorage.getItem(MOCK_EVENTS_KEY)
    if (!raw) return []
    return JSON.parse(raw) as DiaryEvent[]
  } catch {
    return []
  }
}

function mockSaveEvents(events: DiaryEvent[]): void {
  try {
    localStorage.setItem(MOCK_EVENTS_KEY, JSON.stringify(events))
  } catch { /* ignore */ }
}

/** Resolve id+rev conflicts: higher rev wins */
function mockMerge(list: DiaryEvent[], incoming: DiaryEvent): DiaryEvent[] {
  const idx = list.findIndex(e => e.id === incoming.id)
  if (idx === -1) return [...list, incoming]
  if (incoming.rev > list[idx].rev) {
    const next = [...list]
    next[idx] = incoming
    return next
  }
  return list
}

const mockBabyDiary: Window['babyDiary'] = {
  listEvents: async () => {
    // Return max-rev per id (same logic as real JSONL layer)
    const all = mockGetEvents()
    const map = new Map<string, DiaryEvent>()
    for (const e of all) {
      const prev = map.get(e.id)
      if (!prev || e.rev > prev.rev) map.set(e.id, e)
    }
    return Array.from(map.values())
  },

  appendEvent: async (event: DiaryEvent): Promise<'ok' | 'duplicate' | 'error'> => {
    const all = mockGetEvents()
    // Dedup: same id+rev is a no-op
    const exists = all.some(e => e.id === event.id && e.rev === event.rev)
    if (exists) return 'duplicate'
    const merged = mockMerge(all, event)
    mockSaveEvents(merged)
    // Notify listeners (simulate main→renderer push)
    setTimeout(() => {
      _mockListeners.forEach(cb => { try { cb(event) } catch { /* ignore */ } })
    }, 0)
    return 'ok'
  },

  getSettings: async () => {
    try {
      const raw = localStorage.getItem(MOCK_SETTINGS_KEY)
      if (raw) return JSON.parse(raw) as AppSettings
    } catch { /* ignore */ }
    return {
      baby:     { name: '', birthdate: '' },
      profile:  { uid: 'mock-uid', name: '', role: 'mom' },
      familyId: '',
      firebase: null,
    }
  },

  saveSettings: async (settings: AppSettings) => {
    try {
      localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(settings))
    } catch { /* ignore */ }
  },

  exportData: async (_format: ExportFormat) => {
    throw new Error('ELECTRON_ONLY')
  },

  openBackupFolder: async () => {
    throw new Error('ELECTRON_ONLY')
  },

  getDataInfo: async () => {
    const events = await mockBabyDiary.listEvents()
    return {
      dataDir: '(브라우저 모드 — 로컬 스토리지)',
      backupDir: '',
      documentsBackupDir: '',
      eventCount: events.length,
      lastBackupTime: null,
    }
  },

  onEventAppended: (callback: EventCallback) => {
    _mockListeners.push(callback)
    return () => {
      const idx = _mockListeners.indexOf(callback)
      if (idx >= 0) _mockListeners.splice(idx, 1)
    }
  },

  // Auto-update — no-ops in browser/mock mode
  onUpdateReady: (_callback: (payload: { version: string }) => void) => () => {},
  onUpdateAvailable: (_callback: (payload: { version: string; url: string }) => void) => () => {},
  installUpdate: () => {},
  openUpdateDownload: () => {},

  savePdf: async (): Promise<SavePdfResult> => {
    throw new Error('ELECTRON_ONLY')
  },
}

// ────────────────────────────────────────────────────────────
// Resolve: use Electron bridge if available, else mock
// ────────────────────────────────────────────────────────────

function getApi(): Window['babyDiary'] {
  if (typeof window !== 'undefined' && window.babyDiary) {
    return window.babyDiary
  }
  // Warn once
  if (typeof window !== 'undefined') {
    if (!(window as unknown as Record<string, boolean>)['__mockWarned']) {
      (window as unknown as Record<string, boolean>)['__mockWarned'] = true
      console.warn(
        '[Baby Diary] 브라우저 모드 (mock) — window.babyDiary 없음. ' +
        'localStorage 기반 인메모리 목업으로 동작합니다. ' +
        'Electron 환경에서는 이 메시지가 표시되지 않습니다.'
      )
    }
  }
  return mockBabyDiary
}

export const ipc = {
  listEvents:       (): Promise<DiaryEvent[]>    => getApi().listEvents(),
  appendEvent:      (event: DiaryEvent)          => getApi().appendEvent(event),
  getSettings:      (): Promise<AppSettings>     => getApi().getSettings(),
  saveSettings:     (settings: AppSettings)      => getApi().saveSettings(settings),
  exportData:       (format: ExportFormat)       => getApi().exportData(format),
  openBackupFolder: (): Promise<void>            => getApi().openBackupFolder(),
  getDataInfo:      (): Promise<DataInfo>        => getApi().getDataInfo(),
  onEventAppended:  (callback: (event: DiaryEvent) => void): (() => void) =>
    getApi().onEventAppended(callback),
  // Auto-update
  onUpdateReady: (callback: (payload: { version: string }) => void): (() => void) =>
    getApi().onUpdateReady(callback),
  onUpdateAvailable: (callback: (payload: { version: string; url: string }) => void): (() => void) =>
    getApi().onUpdateAvailable(callback),
  installUpdate:       (): void => getApi().installUpdate(),
  openUpdateDownload:  (): void => getApi().openUpdateDownload(),
  savePdf: (): Promise<SavePdfResult> => getApi().savePdf(),
}
