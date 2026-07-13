export type EventType = 'pee' | 'poop' | 'temp' | 'breast' | 'formula' | 'diary' | 'message' | 'sleep' | 'growth'

export interface PeeData { note?: string }
export interface PoopData { note?: string }
export interface TempData { celsius: number; note?: string }
export interface BreastData { side: 'L' | 'R' | 'both'; minutes?: number; note?: string }
export interface FormulaData { ml: number; note?: string }
export interface DiaryData { title?: string; text: string }
export interface MessageData { text: string }
export interface SleepData { minutes: number; note?: string }
export interface GrowthData { weightKg?: number; heightCm?: number; note?: string }

export type EventData =
  | PeeData
  | PoopData
  | TempData
  | BreastData
  | FormulaData
  | DiaryData
  | MessageData
  | SleepData
  | GrowthData

export interface DiaryEvent {
  id: string
  type: EventType
  at: string
  data: EventData
  author: {
    uid: string
    name: string
    role: 'dad' | 'mom'
  }
  createdAt: string
  updatedAt: string
  rev: number
  deleted: boolean
}

export interface AppSettings {
  baby: {
    name: string
    birthdate: string
    gender?: 'girl' | 'boy'
  }
  profile: {
    uid: string
    name: string
    role: 'dad' | 'mom'
  }
  familyId: string
  firebase: {
    apiKey: string
    authDomain: string
    projectId: string
    storageBucket: string
    messagingSenderId: string
    appId: string
  } | null
  language?: 'ko' | 'ja'
  theme?: 'light' | 'dark' | 'system'
}

export interface DataInfo {
  dataDir: string
  backupDir: string
  documentsBackupDir: string
  eventCount: number
  lastBackupTime: string | null
}

export type ExportFormat = 'json' | 'csv'

export type SavePdfResult = { saved: true; path: string } | { saved: false }

export type FirebaseEmulatorBridge =
  | {
      enabled: true
      projectId: 'demo-baby-diary'
      authHost: string
      authPort: 9099
      firestoreHost: string
      firestorePort: 8080
    }
  | {
      enabled: false
      reason: string
    }
