import type {
  AppSettings,
  BabyInfoCommitErrorCode,
  BabyInfoCommitIpcResponse,
  BabyInfoJournalSummary,
  BabyInfoMutation,
  BabyInfoPendingPage,
  BabyInfoPendingPageRequest,
  BabyInfoSettingsCommitOperation,
  BabyInfoSettingsCommitResult,
  BabyInfoUnlinkedArchive,
  DataInfo,
  DiaryEvent,
  EventFamilyConfirmationResult,
  ExportFormat,
  FirebaseEmulatorBridge,
  SavePdfResult,
} from '../../shared/types'
import {
  getBabyInfoArchiveIdFromCursor,
  makeBabyInfoArchiveCursor,
  parseBabyInfoArchivePage,
  parseBabyInfoArchivePageRequest,
  type BabyInfoArchivePage,
  type BabyInfoArchivePageRequest,
} from '../../shared/babyInfoArchivePaging'
import type { HealthEvidenceSourceId } from '../../shared/healthEvidence'
import { getEvidenceSourceById } from '../../shared/healthEvidence'
import { getEventStorageKey, resolveLatestEvent } from '../../shared/eventResolver'
import {
  applyManagedSettingsMerge,
  applyManagedSettingsSave,
  BabyInfoSettingsCommitError,
  incrementBabyInfoRevision,
  parseBabyInfoSettingsCommitOperation,
} from '../../shared/babyInfoSettingsCommit'
import {
  canonicalBabyInfoMutationJson,
  getBabyInfoMutationKey,
  getBabyInfoUnlinkedArchiveId,
  isValidBabyInfoMutationKey,
  makeLegacyLocalBabyInfoMutation,
  normalizeBabyInfoSyncState,
  resolveLatestBabyInfoMutation,
} from '../../shared/babyInfoResolver'
import { assertFamilyId } from '../../shared/familyId'
import { v4 as uuidv4 } from 'uuid'
import {
  getDigestFirebasePersistenceIdentity,
  type FirebaseConfig,
  type FirebasePersistenceClaim,
} from '../../shared/firebasePersistence'

export interface SettingsChangedPayload {
  sequence: number
  settings: AppSettings
}

declare global {
  interface Window {
    babyDiary: {
      getFirebaseEmulator: () => Promise<FirebaseEmulatorBridge | null>
      claimFirebasePersistence: (config: FirebaseConfig) => Promise<FirebasePersistenceClaim>
      openEvidenceSource: (sourceId: HealthEvidenceSourceId) => Promise<void>
      listEvents: (expectedFamilyId?: string) => Promise<DiaryEvent[]>
      listEventMutations: (expectedFamilyId?: string) => Promise<DiaryEvent[]>
      appendEvent: (event: DiaryEvent, expectedFamilyId?: string) => Promise<'ok' | 'duplicate' | 'error'>
      confirmEventFamily: (familyId: string, allowLegacyAdoption?: boolean) => Promise<EventFamilyConfirmationResult>
      getSettings: () => Promise<AppSettings>
      saveSettings: (settings: AppSettings) => Promise<AppSettings>
      mergeSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>
      commitBabyInfo: (operation: BabyInfoSettingsCommitOperation) => Promise<BabyInfoCommitIpcResponse>
      listPendingBabyInfo: (request: BabyInfoPendingPageRequest) => Promise<BabyInfoPendingPage>
      getBabyInfoSummary: (familyId: string) => Promise<BabyInfoJournalSummary>
      getBabyInfoMutation: (familyId: string, key: string) => Promise<BabyInfoMutation | undefined>
      listUnlinkedBabyInfoArchives: (request: BabyInfoArchivePageRequest) => Promise<BabyInfoArchivePage>
      exportData: (format: ExportFormat) => Promise<void>
      openBackupFolder: () => Promise<void>
      getDataInfo: () => Promise<DataInfo>
      onEventAppended: (callback: (event: DiaryEvent, familyId: string) => void) => () => void
      onEventScopeChanged: (callback: () => void) => () => void
      onSettingsChanged: (callback: (payload: SettingsChangedPayload) => void) => () => void
      onUpdateReady: (callback: (payload: { version: string }) => void) => () => void
      onUpdateAvailable: (callback: (payload: { version: string; url: string }) => void) => () => void
      updateRendererReady: () => void
      installUpdate: () => void
      openUpdateDownload: () => void
      savePdf: () => Promise<SavePdfResult>
      reportReady: () => void
    }
  }
}

const MOCK_EVENTS_KEY = 'babydiary.mock.events'
const MOCK_SETTINGS_KEY = 'babydiary.mock.settings'
const MOCK_BABY_INFO_JOURNAL_KEY = 'babydiary.mock.babyInfoJournal.v1'

type EventCallback = (event: DiaryEvent, familyId: string) => void
type SettingsCallback = (payload: SettingsChangedPayload) => void
const mockEventListeners: EventCallback[] = []
const mockSettingsListeners: SettingsCallback[] = []
let mockSettingsSequence = 0

function mockGetEvents(): DiaryEvent[] {
  try {
    const raw = localStorage.getItem(MOCK_EVENTS_KEY)
    return raw ? JSON.parse(raw) as DiaryEvent[] : []
  } catch {
    return []
  }
}

function mockSaveEvents(events: DiaryEvent[]): void {
  try { localStorage.setItem(MOCK_EVENTS_KEY, JSON.stringify(events)) } catch { /* dev fallback */ }
}

function mockDefaultSettings(): AppSettings {
  return {
    baby: { name: '', birthdate: '' },
    profile: { uid: 'mock-uid', name: '', role: 'mom' },
    familyId: '',
    firebase: null,
  }
}

function mockGetSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(MOCK_SETTINGS_KEY)
    return raw ? JSON.parse(raw) as AppSettings : mockDefaultSettings()
  } catch {
    return mockDefaultSettings()
  }
}

function mockWriteSettings(settings: AppSettings, publish = true): AppSettings {
  localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(settings))
  if (publish) {
    mockSettingsSequence += 1
    const payload = { sequence: mockSettingsSequence, settings }
    mockSettingsListeners.forEach(callback => {
      try { callback(payload) } catch { /* isolate listeners */ }
    })
  }
  return settings
}

interface MockJournalState {
  version: 1
  mutations: BabyInfoMutation[]
  acknowledgedKeys: string[]
  unlinkedArchives: BabyInfoUnlinkedArchive[]
}

function mockEmptyJournal(): MockJournalState {
  return { version: 1, mutations: [], acknowledgedKeys: [], unlinkedArchives: [] }
}

function mockGetJournal(): MockJournalState {
  try {
    const raw = localStorage.getItem(MOCK_BABY_INFO_JOURNAL_KEY)
    if (!raw) return mockEmptyJournal()
    const parsed = JSON.parse(raw) as MockJournalState
    if (parsed.version !== 1 || !Array.isArray(parsed.mutations) || !Array.isArray(parsed.acknowledgedKeys)) {
      return mockEmptyJournal()
    }
    if (!Array.isArray(parsed.unlinkedArchives)) parsed.unlinkedArchives = []
    for (const mutation of parsed.mutations) canonicalBabyInfoMutationJson(mutation)
    return parsed
  } catch {
    return mockEmptyJournal()
  }
}

function mockWriteJournal(state: MockJournalState): void {
  localStorage.setItem(MOCK_BABY_INFO_JOURNAL_KEY, JSON.stringify(state))
}

function mockAppendMutation(state: MockJournalState, mutation: BabyInfoMutation): void {
  const canonical = canonicalBabyInfoMutationJson(mutation)
  if (!state.mutations.some(item => canonicalBabyInfoMutationJson(item) === canonical)) {
    state.mutations.push(mutation)
  }
}

function mockSummary(state: MockJournalState, familyIdValue: string): BabyInfoJournalSummary {
  const familyId = assertFamilyId(familyIdValue)
  const acknowledged = new Set(state.acknowledgedKeys)
  const mutations = state.mutations.filter(mutation => mutation.familyId === familyId)
  return {
    familyId,
    mutationCount: mutations.length,
    pendingCount: mutations.filter(item => !acknowledged.has(getBabyInfoMutationKey(item))).length,
    totalPendingCount: mockTotalPending(state),
    winner: resolveLatestBabyInfoMutation(mutations),
  }
}

function mockTotalPending(state: MockJournalState): number {
  return state.mutations.length - new Set(state.acknowledgedKeys).size
}

function mockMigrateLegacy(current: AppSettings, state: MockJournalState): AppSettings {
  if (current.babyInfoSync !== undefined) {
    const legacy = normalizeBabyInfoSyncState(current.babyInfoSync)
    const pending = new Set(legacy.pendingMutationKeys)
    for (const mutation of legacy.mutations) {
      mockAppendMutation(state, mutation)
      const key = getBabyInfoMutationKey(mutation)
      if (!pending.has(key) && !state.acknowledgedKeys.includes(key)) state.acknowledgedKeys.push(key)
    }
  } else if (current.familyId
    && current.babyInfoJournal === undefined
    && state.mutations.length === 0
    && state.acknowledgedKeys.length === 0) {
    const legacy = makeLegacyLocalBabyInfoMutation(
      current.familyId,
      current.baby.name,
      current.baby.birthdate,
    )
    if (legacy) mockAppendMutation(state, legacy)
  }
  if (!current.familyId && (current.baby.name !== '' || current.baby.birthdate !== '')) {
    const archiveId = getBabyInfoUnlinkedArchiveId(current.baby.name, current.baby.birthdate)
    if (!state.unlinkedArchives.some(item => item.archiveId === archiveId)) {
      state.unlinkedArchives.push({
        archiveId,
        babyName: current.baby.name,
        babyBirthdate: current.baby.birthdate,
        archivedAt: new Date().toISOString(),
        source: 'legacy-unscoped',
      })
    }
  }
  const summary = current.familyId ? mockSummary(state, current.familyId) : undefined
  const winner = summary?.winner
  return {
    ...current,
    baby: winner
      ? { ...current.baby, name: winner.babyName, birthdate: winner.babyBirthdate }
      : current.familyId
        ? { ...current.baby, name: '', birthdate: '' }
        : { ...current.baby, name: '', birthdate: '' },
    babyInfoSync: undefined,
    babyInfoJournal: {
      version: 1,
      projectedFamilyId: current.familyId,
      projectedWinnerKey: winner ? getBabyInfoMutationKey(winner) : undefined,
    },
  }
}

function mockProjectFamily(
  current: AppSettings,
  state: MockJournalState,
  familyId: string,
): AppSettings {
  const summary = familyId ? mockSummary(state, familyId) : undefined
  return {
    ...current,
    familyId,
    baby: {
      ...current.baby,
      name: summary?.winner?.babyName ?? '',
      birthdate: summary?.winner?.babyBirthdate ?? '',
    },
    babyInfoSync: undefined,
    babyInfoJournal: {
      version: 1,
      projectedFamilyId: familyId,
      projectedWinnerKey: summary?.winner ? getBabyInfoMutationKey(summary.winner) : undefined,
    },
    babyInfoRevision: incrementBabyInfoRevision(current),
  }
}

function mockCommit(rawOperation: unknown): BabyInfoSettingsCommitResult {
  const operation = parseBabyInfoSettingsCommitOperation(rawOperation)
  const journal = mockGetJournal()
  let current = mockMigrateLegacy(mockGetSettings(), journal)

  if (operation.kind === 'family-transition') {
    current = mockProjectFamily(current, journal, operation.familyId)
    mockWriteJournal(journal)
    mockWriteSettings(current)
    const summary = mockSummary(journal, operation.familyId)
    return {
      kind: 'family-transition',
      settings: current,
      babyInfo: summary.pendingCount > 0 ? 'pending' : 'unchanged',
      pendingCount: mockTotalPending(journal),
      activePendingCount: summary.pendingCount,
      winner: summary.winner,
    }
  }

  if (operation.familyId !== current.familyId) {
    throw new BabyInfoSettingsCommitError('FAMILY_MISMATCH', 'baby info family mismatch')
  }

  if (operation.kind === 'user-edit') {
    current = applyManagedSettingsSave(current, operation.settings)
    const changed = current.baby.name !== operation.babyName
      || current.baby.birthdate !== operation.babyBirthdate
    let mutation: BabyInfoMutation | undefined
    if (changed && operation.familyId) {
      const before = mockSummary(journal, operation.familyId)
      mutation = {
        mutationId: uuidv4(),
        familyId: operation.familyId,
        babyName: operation.babyName,
        babyBirthdate: operation.babyBirthdate,
        logicalClock: (before.winner?.logicalClock ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        authorId: current.profile.uid || 'local',
        origin: 'user',
      }
      mockAppendMutation(journal, mutation)
    }
    const summary = operation.familyId ? mockSummary(journal, operation.familyId) : undefined
    if (changed) {
      current = {
        ...current,
        baby: { ...current.baby, name: operation.babyName, birthdate: operation.babyBirthdate },
        babyInfoJournal: {
          version: 1,
          projectedFamilyId: operation.familyId,
          projectedWinnerKey: summary?.winner ? getBabyInfoMutationKey(summary.winner) : undefined,
        },
        babyInfoRevision: incrementBabyInfoRevision(current),
      }
    }
    mockWriteJournal(journal)
    mockWriteSettings(current)
    const pendingCount = mockTotalPending(journal)
    return {
      kind: 'user-edit',
      settings: current,
      babyInfo: changed
        ? operation.familyId ? 'pending' : 'local-only'
        : pendingCount > 0 ? 'pending' : 'unchanged',
      mutation,
      pendingCount,
      activePendingCount: summary?.pendingCount ?? 0,
      winner: summary?.winner,
    }
  }

  for (const mutation of operation.discoveredMutations) mockAppendMutation(journal, mutation)
  const byKey = new Map(journal.mutations.map(item => [getBabyInfoMutationKey(item), item]))
  for (const key of operation.exactAcknowledgedMutationKeys) {
    const mutation = byKey.get(key)
    if (!mutation) throw new BabyInfoSettingsCommitError('INVALID_OPERATION', 'unknown acknowledgement')
    if (mutation.familyId !== operation.familyId) {
      throw new BabyInfoSettingsCommitError('FAMILY_MISMATCH', 'acknowledgement family mismatch')
    }
    if (!journal.acknowledgedKeys.includes(key)) journal.acknowledgedKeys.push(key)
  }
  const summary = mockSummary(journal, operation.familyId)
  current = {
    ...current,
    baby: summary.winner
      ? { ...current.baby, name: summary.winner.babyName, birthdate: summary.winner.babyBirthdate }
      : current.baby,
    babyInfoJournal: {
      version: 1,
      projectedFamilyId: operation.familyId,
      projectedWinnerKey: summary.winner ? getBabyInfoMutationKey(summary.winner) : undefined,
    },
    babyInfoRevision: incrementBabyInfoRevision(current),
  }
  mockWriteJournal(journal)
  mockWriteSettings(current)
  const pendingCount = mockTotalPending(journal)
  return {
    kind: 'reconcile',
    settings: current,
    babyInfo: pendingCount > 0 ? 'pending' : 'unchanged',
    pendingCount,
    activePendingCount: summary.pendingCount,
    winner: summary.winner,
  }
}

const mockBabyDiary: Window['babyDiary'] = {
  getFirebaseEmulator: async () => null,
  claimFirebasePersistence: async config => {
    const identity = getDigestFirebasePersistenceIdentity(config)
    return {
      version: 1,
      configIdentity: identity.configIdentity,
      appName: identity.appName,
    }
  },
  openEvidenceSource: async (sourceId: HealthEvidenceSourceId): Promise<void> => {
    if (!getEvidenceSourceById(sourceId)) throw new Error('Unknown health evidence source')
    throw new Error('EVIDENCE_LINK_UNAVAILABLE')
  },
  listEvents: async (expectedFamilyId?: string) => {
    const currentFamilyId = mockGetSettings().familyId
    if (expectedFamilyId !== undefined && expectedFamilyId !== currentFamilyId) {
      throw new Error('EVENT_FAMILY_MISMATCH')
    }
    const grouped = new Map<string, DiaryEvent[]>()
    for (const event of mockGetEvents()) {
      const group = grouped.get(event.id) ?? []
      group.push(event)
      grouped.set(event.id, group)
    }
    return Array.from(grouped.values()).map(events => resolveLatestEvent(events)!).filter(Boolean)
  },
  listEventMutations: async (expectedFamilyId?: string) => {
    const currentFamilyId = mockGetSettings().familyId
    if (expectedFamilyId !== undefined && expectedFamilyId !== currentFamilyId) {
      throw new Error('EVENT_FAMILY_MISMATCH')
    }
    return mockGetEvents()
  },
  appendEvent: async (event: DiaryEvent, expectedFamilyId?: string): Promise<'ok' | 'duplicate' | 'error'> => {
    const currentFamilyId = mockGetSettings().familyId
    if (expectedFamilyId !== undefined && expectedFamilyId !== currentFamilyId) return 'error'
    const all = mockGetEvents()
    const key = getEventStorageKey(event)
    if (all.some(existing => getEventStorageKey(existing) === key)) return 'duplicate'
    mockSaveEvents([...all, event])
    setTimeout(() => mockEventListeners.forEach(callback => {
      try { callback(event, currentFamilyId) } catch { /* isolate listeners */ }
    }), 0)
    return 'ok'
  },
  confirmEventFamily: async (familyId: string, _allowLegacyAdoption = true): Promise<EventFamilyConfirmationResult> => ({
    status: familyId ? 'ok' : 'error',
    ...(familyId ? { adoptionFamilyId: familyId } : {}),
    adoptedCount: 0,
  }),
  getSettings: async () => mockGetSettings(),
  saveSettings: async settings => {
    const journal = mockGetJournal()
    const current = mockMigrateLegacy(mockGetSettings(), journal)
    let next = applyManagedSettingsSave(current, settings)
    if (next.familyId !== current.familyId) next = mockProjectFamily(next, journal, next.familyId)
    mockWriteJournal(journal)
    return mockWriteSettings(next)
  },
  mergeSettings: async partial => {
    const journal = mockGetJournal()
    const current = mockMigrateLegacy(mockGetSettings(), journal)
    let next = applyManagedSettingsMerge(current, partial)
    if (next.familyId !== current.familyId) next = mockProjectFamily(next, journal, next.familyId)
    mockWriteJournal(journal)
    return mockWriteSettings(next)
  },
  commitBabyInfo: async operation => {
    try {
      return { ok: true, value: mockCommit(operation) }
    } catch (error) {
      const code: BabyInfoCommitErrorCode = error instanceof BabyInfoSettingsCommitError
        ? error.code
        : 'STORAGE_FAILURE'
      return {
        ok: false,
        error: {
          code,
          message: code === 'FAMILY_MISMATCH'
            ? 'Baby info family changed. Refresh and try again.'
            : code === 'INVALID_OPERATION'
              ? 'Invalid baby info operation.'
              : 'Unable to save baby info settings.',
        },
      }
    }
  },
  listPendingBabyInfo: async request => {
    const familyId = assertFamilyId(request.familyId)
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 500) {
      throw new Error('invalid baby info pending page limit')
    }
    const state = mockGetJournal()
    const acknowledged = new Set(state.acknowledgedKeys)
    const pending = state.mutations
      .filter(item => item.familyId === familyId && !acknowledged.has(getBabyInfoMutationKey(item)))
      .sort((left, right) => getBabyInfoMutationKey(left).localeCompare(getBabyInfoMutationKey(right)))
    const start = request.afterKey === undefined
      ? 0
      : pending.findIndex(item => getBabyInfoMutationKey(item) > request.afterKey!)
    if (start < 0) return { items: [] }
    const items = pending.slice(start, start + request.limit)
    return {
      items,
      nextCursor: start + items.length < pending.length
        ? getBabyInfoMutationKey(items[items.length - 1])
        : undefined,
    }
  },
  getBabyInfoSummary: async familyId => mockSummary(mockGetJournal(), familyId),
  getBabyInfoMutation: async (familyId, key) => {
    const validFamilyId = assertFamilyId(familyId)
    if (!isValidBabyInfoMutationKey(key)) throw new Error('invalid baby info mutation key')
    const candidate = mockGetJournal().mutations.find(item => getBabyInfoMutationKey(item) === key)
    return candidate?.familyId === validFamilyId ? candidate : undefined
  },
  listUnlinkedBabyInfoArchives: async rawRequest => {
    const request = parseBabyInfoArchivePageRequest(rawRequest)
    const ordered = mockGetJournal().unlinkedArchives
      .map(item => ({ ...item }))
      .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt)
        || left.archiveId.localeCompare(right.archiveId))
    let start = 0
    if (request.cursor) {
      const cursorId = getBabyInfoArchiveIdFromCursor(request.cursor)
      const cursorIndex = ordered.findIndex(item => item.archiveId === cursorId)
      if (cursorIndex < 0) throw new Error('baby info archive page cursor is unknown')
      start = cursorIndex + 1
    }
    const items = ordered.slice(start, start + request.limit)
    return {
      items,
      ...(start + items.length < ordered.length
        ? { nextCursor: makeBabyInfoArchiveCursor(items[items.length - 1].archiveId) }
        : {}),
    }
  },
  exportData: async () => { throw new Error('ELECTRON_ONLY') },
  openBackupFolder: async () => { throw new Error('ELECTRON_ONLY') },
  getDataInfo: async () => ({
    dataDir: '(browser mock localStorage)',
    backupDir: '',
    documentsBackupDir: '',
    eventCount: (await mockBabyDiary.listEvents()).length,
    lastBackupTime: null,
  }),
  onEventAppended: callback => {
    mockEventListeners.push(callback)
    return () => {
      const index = mockEventListeners.indexOf(callback)
      if (index >= 0) mockEventListeners.splice(index, 1)
    }
  },
  onEventScopeChanged: () => () => undefined,
  onSettingsChanged: callback => {
    mockSettingsListeners.push(callback)
    return () => {
      const index = mockSettingsListeners.indexOf(callback)
      if (index >= 0) mockSettingsListeners.splice(index, 1)
    }
  },
  onUpdateReady: () => () => {},
  onUpdateAvailable: () => () => {},
  updateRendererReady: () => {},
  installUpdate: () => {},
  openUpdateDownload: () => {},
  savePdf: async () => { throw new Error('ELECTRON_ONLY') },
  reportReady: () => {},
}

function getApi(): Window['babyDiary'] {
  if (typeof window !== 'undefined' && window.babyDiary) return window.babyDiary
  if (typeof window !== 'undefined'
    && !(window as unknown as Record<string, boolean>).__mockWarned) {
    ;(window as unknown as Record<string, boolean>).__mockWarned = true
    console.warn('[Baby Diary] Browser mock mode: window.babyDiary is unavailable.')
  }
  return mockBabyDiary
}

export class BabyInfoCommitClientError extends Error {
  readonly code: BabyInfoCommitErrorCode

  constructor(code: BabyInfoCommitErrorCode, message: string) {
    super(message)
    this.name = 'BabyInfoCommitClientError'
    this.code = code
  }
}

export const ipc = {
  getFirebaseEmulator: (): Promise<FirebaseEmulatorBridge | null> => getApi().getFirebaseEmulator(),
  claimFirebasePersistence: (config: FirebaseConfig): Promise<FirebasePersistenceClaim> =>
    getApi().claimFirebasePersistence(config),
  openEvidenceSource: (sourceId: HealthEvidenceSourceId): Promise<void> => getApi().openEvidenceSource(sourceId),
  listEvents: (expectedFamilyId?: string): Promise<DiaryEvent[]> => getApi().listEvents(expectedFamilyId),
  listEventMutations: (expectedFamilyId?: string): Promise<DiaryEvent[]> =>
    getApi().listEventMutations(expectedFamilyId),
  appendEvent: (event: DiaryEvent, expectedFamilyId?: string) =>
    getApi().appendEvent(event, expectedFamilyId),
  confirmEventFamily: (familyId: string, allowLegacyAdoption = true): Promise<EventFamilyConfirmationResult> =>
    getApi().confirmEventFamily(familyId, allowLegacyAdoption),
  getSettings: (): Promise<AppSettings> => getApi().getSettings(),
  saveSettings: (settings: AppSettings): Promise<AppSettings> => getApi().saveSettings(settings),
  mergeSettings: (partial: Partial<AppSettings>): Promise<AppSettings> => getApi().mergeSettings(partial),
  commitBabyInfo: async (
    operation: BabyInfoSettingsCommitOperation,
  ): Promise<BabyInfoSettingsCommitResult> => {
    const response = await getApi().commitBabyInfo(operation)
    if (response.ok) return response.value
    throw new BabyInfoCommitClientError(response.error.code, response.error.message)
  },
  listPendingBabyInfo: (request: BabyInfoPendingPageRequest): Promise<BabyInfoPendingPage> =>
    getApi().listPendingBabyInfo(request),
  getBabyInfoSummary: (familyId: string): Promise<BabyInfoJournalSummary> =>
    getApi().getBabyInfoSummary(familyId),
  getBabyInfoMutation: (familyId: string, key: string): Promise<BabyInfoMutation | undefined> =>
    getApi().getBabyInfoMutation(familyId, key),
  listUnlinkedBabyInfoArchives: async (
    request: BabyInfoArchivePageRequest,
  ): Promise<BabyInfoArchivePage> => {
    const parsedRequest = parseBabyInfoArchivePageRequest(request)
    return parseBabyInfoArchivePage(await getApi().listUnlinkedBabyInfoArchives(parsedRequest))
  },
  exportData: (format: ExportFormat) => getApi().exportData(format),
  openBackupFolder: (): Promise<void> => getApi().openBackupFolder(),
  getDataInfo: (): Promise<DataInfo> => getApi().getDataInfo(),
  onEventAppended: (callback: (event: DiaryEvent, familyId: string) => void): (() => void) =>
    getApi().onEventAppended(callback),
  onEventScopeChanged: (callback: () => void): (() => void) => {
    const api = getApi()
    return typeof api.onEventScopeChanged === 'function'
      ? api.onEventScopeChanged(callback)
      : () => undefined
  },
  onSettingsChanged: (callback: (payload: SettingsChangedPayload) => void): (() => void) =>
    getApi().onSettingsChanged(callback),
  onUpdateReady: (callback: (payload: { version: string }) => void): (() => void) =>
    getApi().onUpdateReady(callback),
  onUpdateAvailable: (callback: (payload: { version: string; url: string }) => void): (() => void) =>
    getApi().onUpdateAvailable(callback),
  updateRendererReady: (): void => getApi().updateRendererReady(),
  installUpdate: (): void => getApi().installUpdate(),
  openUpdateDownload: (): void => getApi().openUpdateDownload(),
  savePdf: (): Promise<SavePdfResult> => getApi().savePdf(),
  reportReady: (): void => getApi().reportReady(),
}
