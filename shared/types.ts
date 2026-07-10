export type EventType = 'pee' | 'poop' | 'temp' | 'breast' | 'formula' | 'diary' | 'message'

export interface PeeData { note?: string }
export interface PoopData { note?: string }
export interface TempData { celsius: number; note?: string }
export interface BreastData { side: 'L' | 'R' | 'both'; minutes?: number; note?: string }
export interface FormulaData { ml: number; note?: string }
export interface DiaryData { title?: string; text: string }
export interface MessageData { text: string }

export type EventData =
  | PeeData
  | PoopData
  | TempData
  | BreastData
  | FormulaData
  | DiaryData
  | MessageData

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
}

export interface DataInfo {
  dataDir: string
  backupDir: string
  documentsBackupDir: string
  eventCount: number
  lastBackupTime: string | null
}

export type ExportFormat = 'json' | 'csv'
