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

export interface DiaryEventSyncMetadata {
  version: 1
  encodedEventId: string
  eventAtMs: number
  createdAtMs: number
  updatedAtMs: number
}

export interface DiaryEventMigrationProvenance {
  version: 1
  kind: 'legacy-author-v1'
  /** Content identity of the untouched source mutation retained in EventLog. */
  sourceContentId: string
}

export interface DiaryEvent {
  id: string
  /** Globally unique identity for this immutable mutation. Missing only on legacy records. */
  mutationId?: string
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
  /** Numeric timestamp shadows used jointly by clients and Firestore rules. */
  sync?: DiaryEventSyncMetadata
  /** Present only on a durable, auth-bound derivative of a legacy source. */
  migration?: DiaryEventMigrationProvenance
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
  /** Durable, lossless baby-info mutation log. Missing only on legacy settings. */
  babyInfoSync?: BabyInfoSyncState
  /** Bounded projection metadata for the main-process sidecar journal. */
  babyInfoJournal?: BabyInfoJournalMetadata
  /** Main-process managed revision guarding the baby-info pair and sync state. */
  babyInfoRevision?: number
}

export interface BabyInfoJournalMetadata {
  version: 1
  /** Empty only while the app is not linked to a family. */
  projectedFamilyId: string
  projectedWinnerKey?: string
}

export type BabyInfoMutationOrigin = 'user' | 'legacy-local' | 'legacy-cloud'

export interface BabyInfoMutationMigrationProvenance {
  version: 1
  kind: 'legacy-cloud-boundary-v1' | 'legacy-pair-bridge-v1'
  sourceMutationKey: string
}

export interface BabyInfoMutation {
  mutationId: string
  familyId: string
  babyName: string
  babyBirthdate: string
  logicalClock: number
  updatedAt: string
  /** Exact numeric shadow of updatedAt for server-time rule bounds. */
  updatedAtMs?: number
  authorId: string
  origin: BabyInfoMutationOrigin
  migration?: BabyInfoMutationMigrationProvenance
}

/** Familyless legacy values retained locally until a user explicitly reviews them. */
export interface BabyInfoUnlinkedArchive {
  /** Deterministic content identity used to deduplicate repeated upgrade attempts. */
  archiveId: string
  babyName: string
  babyBirthdate: string
  archivedAt: string
  source: 'legacy-unscoped'
}

export interface BabyInfoSyncState {
  version: 1
  mutations: BabyInfoMutation[]
  /** Exact content-bound identities awaiting verified cloud read-back. */
  pendingMutationKeys: string[]
}

export type BabyInfoPersistenceStatus = 'unchanged' | 'local-only' | 'pending'

export interface BabyInfoUserEditCommit {
  kind: 'user-edit'
  /** Empty is allowed only for an unlinked, local-only edit. */
  familyId: string
  babyName: string
  babyBirthdate: string
}

export interface BabyInfoReconcileCommit {
  kind: 'reconcile'
  familyId: string
  /** Strictly validated immutable originals discovered during network work. */
  discoveredMutations: BabyInfoMutation[]
  /** Content-bound keys confirmed by an exact Firestore read-back. */
  exactAcknowledgedMutationKeys: string[]
}

export interface BabyInfoFamilyTransitionCommit {
  kind: 'family-transition'
  /** The non-empty destination family whose projection becomes visible. */
  familyId: string
  /** Creation and joining both select destination history or a blank projection. */
  mode: 'create' | 'join'
}

export type BabyInfoSettingsCommitOperation =
  | BabyInfoUserEditCommit
  | BabyInfoReconcileCommit
  | BabyInfoFamilyTransitionCommit

export interface BabyInfoSettingsCommitResult {
  kind: BabyInfoSettingsCommitOperation['kind']
  settings: AppSettings
  babyInfo: BabyInfoPersistenceStatus
  /** Present only when a user edit created a new immutable original. */
  mutation?: BabyInfoMutation
  /** All durable pending identities across every retained family. */
  pendingCount: number
  /** Count only; pending originals are fetched through bounded page IPC. */
  activePendingCount: number
  winner?: BabyInfoMutation
}

export interface BabyInfoPendingPageRequest {
  familyId: string
  limit: number
  afterKey?: string
}

export interface BabyInfoPendingPage {
  items: BabyInfoMutation[]
  nextCursor?: string
}

export interface BabyInfoJournalSummary {
  familyId: string
  mutationCount: number
  pendingCount: number
  /** All durable pending identities across every retained family. */
  totalPendingCount: number
  winner?: BabyInfoMutation
}

export type BabyInfoCommitErrorCode =
  | 'INVALID_OPERATION'
  | 'FAMILY_MISMATCH'
  | 'STORAGE_FAILURE'
  | 'RECOVERY_REQUIRED'
  | 'INTERNAL_ERROR'

export type BabyInfoCommitIpcResponse =
  | { ok: true; value: BabyInfoSettingsCommitResult }
  | { ok: false; error: { code: BabyInfoCommitErrorCode; message: string } }

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
