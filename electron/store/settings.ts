import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import type { BabyInfoArchivePage } from '../../shared/babyInfoArchivePaging'
import type {
  AppSettings,
  BabyInfoJournalMetadata,
  BabyInfoJournalSummary,
  BabyInfoMutation,
  BabyInfoPendingPage,
  BabyInfoPendingPageRequest,
  BabyInfoSettingsCommitResult,
} from '../../shared/types'
import {
  applyManagedSettingsMerge,
  applyManagedSettingsSave,
  BabyInfoSettingsCommitError,
  incrementBabyInfoRevision,
  parseAppSettings,
  parseAppSettingsWithLegacyDefaults,
  parseBabyInfoSettingsCommitOperation,
  type DeepPartial,
} from '../../shared/babyInfoSettingsCommit'
import {
  canonicalBabyInfoMutationJson,
  getBabyInfoMutationKey,
  isValidBabyInfoMutationKey,
  makeLegacyLocalBabyInfoMutation,
  normalizeBabyInfoSyncState,
} from '../../shared/babyInfoResolver'
import { assertFamilyId } from '../../shared/familyId'
import { BabyInfoJournal } from './babyInfoJournal'
import {
  recoverSettingsAndJournalPair,
  SettingsRecoveryError,
  type RecoveryOptions,
} from './backupSnapshot'
import {
  atomicReplaceFileSync,
  isDurableAppendCommittedError,
  isDurableAppendUncertainError,
  isDurableReplaceCommittedError,
  isDurableTruncateCommittedError,
  isDurableTruncateUncertainError,
  type DurableWriteOptions,
} from './durableFs'

const DEFAULT_SETTINGS: AppSettings = {
  baby: {
    name: '',
    birthdate: '',
    gender: undefined,
  },
  profile: {
    uid: '',
    name: '',
    role: 'dad',
  },
  familyId: '',
  firebase: null,
}

export class SettingsLocalMutationRecoveryError extends SettingsRecoveryError {
  readonly localDataModified = true as const
  readonly readOnly = true as const
  readonly archiveEvidence: { archiveId: string; durable: true }

  constructor(archiveId: string, cause: unknown) {
    super(
      'A baby-info archive became durable before its settings projection failed.',
      [],
      false,
      true,
    )
    this.name = 'SettingsLocalMutationRecoveryError'
    this.archiveEvidence = { archiveId, durable: true }
    Object.assign(this, { cause })
  }
}

export class SettingsCommittedWriteRecoveryError extends SettingsRecoveryError {
  readonly localDataModified = true as const
  readonly readOnly = true as const
  readonly settingsEvidence = {
    committed: true as const,
    fileSynced: true as const,
    durabilityConfirmed: false as const,
  }

  constructor(cause: unknown) {
    super('A settings replacement committed before final durability confirmation failed.', [], false, true)
    this.name = 'SettingsCommittedWriteRecoveryError'
    Object.assign(this, { cause })
  }
}

export class SettingsJournalMutationRecoveryError extends SettingsRecoveryError {
  readonly localDataModified = true as const
  readonly readOnly = true as const
  readonly journalEvidence: {
    kind: 'legacy-import' | 'legacy-local-pair' | 'user-edit' | 'reconcile'
    durable: true
  }
  readonly settingsEvidence?: SettingsCommittedWriteRecoveryError['settingsEvidence']

  constructor(
    kind: 'legacy-import' | 'legacy-local-pair' | 'user-edit' | 'reconcile',
    cause: unknown,
  ) {
    super('Baby-info journal changes became durable before settings projection failed.', [], false, true)
    this.name = 'SettingsJournalMutationRecoveryError'
    this.journalEvidence = { kind, durable: true }
    if (cause instanceof SettingsCommittedWriteRecoveryError) {
      this.settingsEvidence = cause.settingsEvidence
    }
    Object.assign(this, { cause })
  }
}

export class SettingsJournalStorageRecoveryError extends SettingsRecoveryError {
  readonly localDataModified = true as const
  readonly readOnly = true as const
  readonly journalEvidence: {
    kind: 'storage-uncertain'
    durable: boolean
    committed: boolean
    uncertain: true
  }

  constructor(cause: unknown) {
    const committed = isDurableAppendCommittedError(cause)
      || isDurableTruncateCommittedError(cause)
    super('Baby-info journal storage changed but the process could not safely continue.', [], false, true)
    this.name = 'SettingsJournalStorageRecoveryError'
    this.journalEvidence = {
      kind: 'storage-uncertain',
      durable: committed,
      committed,
      uncertain: true,
    }
    Object.assign(this, { cause })
  }
}

function isJournalStorageRecoveryError(error: unknown): boolean {
  return isDurableAppendCommittedError(error)
    || isDurableAppendUncertainError(error)
    || isDurableTruncateCommittedError(error)
    || isDurableTruncateUncertainError(error)
    || (typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'BABY_INFO_STORAGE_UNCERTAIN')
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

function tryParse(raw: string): AppSettings | null {
  try {
    return JSON.parse(stripBom(raw)) as AppSettings
  } catch {
    return null
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function legacyImportId(state: unknown): string {
  const normalized = normalizeBabyInfoSyncState(state)
  return `settings-v1:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`
}

function parsePendingPageRequest(value: unknown): BabyInfoPendingPageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('baby info pending page request is invalid')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.some(key => key !== 'familyId' && key !== 'limit' && key !== 'afterKey')
    || typeof record.familyId !== 'string'
    || !Number.isInteger(record.limit)
    || (record.afterKey !== undefined && !isValidBabyInfoMutationKey(record.afterKey))) {
    throw new Error('baby info pending page request is invalid')
  }
  return {
    familyId: assertFamilyId(record.familyId),
    limit: record.limit as number,
    afterKey: record.afterKey as string | undefined,
  }
}

export class SettingsStore {
  private readonly settingsPath: string
  private readonly durableWriteOptions: DurableWriteOptions
  private settings: AppSettings = { ...DEFAULT_SETTINGS }
  private readonly journal: BabyInfoJournal
  private storageRecoveryError: SettingsRecoveryError | undefined

  constructor(userDataPath: string, options: RecoveryOptions = {}) {
    this.settingsPath = path.join(userDataPath, 'settings.json')
    this.durableWriteOptions = {
      ...(options.durableFs ? { fs: options.durableFs } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    }
    recoverSettingsAndJournalPair(userDataPath, {
      ...options,
      startupId: options.startupId ?? uuidv4(),
    })
    this.load()
    let journal: BabyInfoJournal
    try {
      journal = new BabyInfoJournal(userDataPath, {
        durableFs: options.durableFs,
        platform: options.platform,
      })
    } catch (error) {
      throw this.normalizeStorageRecoveryError(error)
    }
    this.journal = journal
    try {
      this.recoverJournalProjection()
    } catch (error) {
      throw this.normalizeStorageRecoveryError(error)
    }
  }

  private load(): void {
    if (!fs.existsSync(this.settingsPath)) {
      this.settings = {
        ...DEFAULT_SETTINGS,
        baby: { ...DEFAULT_SETTINGS.baby },
        profile: { ...DEFAULT_SETTINGS.profile },
      }
      return
    }
    let raw: string
    try {
      raw = fs.readFileSync(this.settingsPath, 'utf8')
    } catch (error) {
      throw new SettingsRecoveryError(
        `Unable to read settings.json: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const parsed = tryParse(raw)
    if (parsed === null) {
      throw new SettingsRecoveryError('settings.json became invalid after startup recovery')
    }
    try {
      this.settings = parseAppSettingsWithLegacyDefaults(parsed)
    } catch (error) {
      throw new SettingsRecoveryError(
        `settings.json failed strict validation: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  get(): AppSettings {
    return {
      ...this.settings,
      baby: { ...this.settings.baby },
      profile: { ...this.settings.profile },
      babyInfoJournal: this.settings.babyInfoJournal
        ? { ...this.settings.babyInfoJournal }
        : undefined,
    }
  }

  private assertStorageWritable(): void {
    if (this.storageRecoveryError) throw this.storageRecoveryError
  }

  private normalizeStorageRecoveryError(error: unknown): unknown {
    if (error instanceof SettingsRecoveryError) {
      if ((error as SettingsRecoveryError & { localDataModified?: unknown }).localDataModified === true
        || (error as SettingsRecoveryError & { readOnly?: unknown }).readOnly === true) {
        this.storageRecoveryError = error
      }
      return error
    }
    if (isJournalStorageRecoveryError(error)) {
      const recovery = new SettingsJournalStorageRecoveryError(error)
      this.storageRecoveryError = recovery
      return recovery
    }
    return error
  }

  private write(settings: AppSettings): void {
    this.assertStorageWritable()
    const content = Buffer.from(JSON.stringify(settings, null, 2), 'utf8')
    try {
      atomicReplaceFileSync(this.settingsPath, content, this.durableWriteOptions)
    } catch (error) {
      if (isDurableReplaceCommittedError(error)) {
        const recovery = new SettingsCommittedWriteRecoveryError(error)
        this.storageRecoveryError = recovery
        throw recovery
      }
      const message = error instanceof Error ? error.message : String(error)
      const structured = new Error(`[Settings] save failed: ${message}`)
      ;(structured as NodeJS.ErrnoException).code = (error as NodeJS.ErrnoException).code
      throw structured
    }
    this.settings = {
      ...settings,
      baby: { ...settings.baby },
      profile: { ...settings.profile },
    }
  }

  private projectionMetadata(
    familyId: string,
    winner: BabyInfoMutation | undefined,
  ): BabyInfoJournalMetadata {
    return {
      version: 1,
      projectedFamilyId: familyId,
      projectedWinnerKey: winner ? getBabyInfoMutationKey(winner) : undefined,
    }
  }

  private projectFamily(settings: AppSettings, familyId: string): AppSettings {
    const winner = familyId ? this.journal.getSummary(familyId).winner : undefined
    return {
      ...settings,
      familyId,
      baby: {
        ...settings.baby,
        name: winner?.babyName ?? '',
        birthdate: winner?.babyBirthdate ?? '',
      },
      babyInfoSync: undefined,
      babyInfoJournal: this.projectionMetadata(familyId, winner),
      babyInfoRevision: incrementBabyInfoRevision(settings),
    }
  }

  /**
   * Import the legacy settings source only after the journal is durable, then
   * recover a possibly interrupted settings projection from the journal index.
   */
  private recoverJournalProjection(): void {
    const current = parseAppSettings(this.settings)
    const journalWasEmpty = !this.journal.hasAnyRecords()
    let sourceRemoved = false
    let unlinkedArchiveId: string | undefined
    let journalMutationKind: 'legacy-import' | 'legacy-local-pair' | undefined

    if (current.babyInfoSync !== undefined) {
      const sourceId = legacyImportId(current.babyInfoSync)
      this.journal.importLegacyState(sourceId, current.babyInfoSync)
      sourceRemoved = true
      journalMutationKind = 'legacy-import'
    }

    if (!current.familyId && (current.baby.name !== '' || current.baby.birthdate !== '')) {
      unlinkedArchiveId = this.journal
        .archiveUnlinkedPair(current.baby.name, current.baby.birthdate)
        ?.archiveId
    }

    let winner: BabyInfoMutation | undefined
    if (current.familyId) {
      assertFamilyId(current.familyId)
      let summary = this.journal.getSummary(current.familyId)
      if (summary.mutationCount === 0
        && current.babyInfoSync === undefined
        && current.babyInfoJournal === undefined
        && journalWasEmpty) {
        const legacy = makeLegacyLocalBabyInfoMutation(
          current.familyId,
          current.baby.name,
          current.baby.birthdate,
        )
        if (legacy) {
          summary = this.journal.ingest(current.familyId, [legacy], [])
          journalMutationKind = 'legacy-local-pair'
        }
      }
      winner = summary.winner
    }

    const metadata = this.projectionMetadata(current.familyId, winner)
    const desiredName = winner?.babyName ?? ''
    const desiredBirthdate = winner?.babyBirthdate ?? ''
    const pairChanged = current.baby.name !== desiredName
      || current.baby.birthdate !== desiredBirthdate
    const metadataChanged = !sameValue(current.babyInfoJournal, metadata)
    if (!sourceRemoved && !pairChanged && !metadataChanged) return

    const next: AppSettings = {
      ...current,
      baby: { ...current.baby, name: desiredName, birthdate: desiredBirthdate },
      babyInfoSync: undefined,
      babyInfoJournal: metadata,
      babyInfoRevision: incrementBabyInfoRevision(current),
    }
    try {
      this.write(next)
    } catch (error) {
      if (unlinkedArchiveId) {
        throw new SettingsLocalMutationRecoveryError(unlinkedArchiveId, error)
      }
      if (journalMutationKind) {
        throw new SettingsJournalMutationRecoveryError(journalMutationKind, error)
      }
      throw error
    }
  }

  save(settings: AppSettings): AppSettings {
    this.assertStorageWritable()
    try {
      this.load()
      this.recoverJournalProjection()
      const currentFamilyId = this.settings.familyId
      let next = applyManagedSettingsSave(this.settings, settings)
      if (next.familyId !== currentFamilyId) next = this.projectFamily(next, next.familyId)
      this.write(next)
      return this.get()
    } catch (error) {
      throw this.normalizeStorageRecoveryError(error)
    }
  }

  merge(partial: DeepPartial<AppSettings>): AppSettings {
    this.assertStorageWritable()
    try {
      this.load()
      this.recoverJournalProjection()
      const currentFamilyId = this.settings.familyId
      let next = applyManagedSettingsMerge(this.settings, partial)
      if (next.familyId !== currentFamilyId) next = this.projectFamily(next, next.familyId)
      this.write(next)
      return this.get()
    } catch (error) {
      throw this.normalizeStorageRecoveryError(error)
    }
  }

  listPendingBabyInfo(rawRequest: unknown): BabyInfoPendingPage {
    this.assertStorageWritable()
    const request = parsePendingPageRequest(rawRequest)
    return this.journal.listPending(request.familyId, {
      limit: request.limit,
      afterKey: request.afterKey,
    })
  }

  getBabyInfoSummary(familyId: string): BabyInfoJournalSummary {
    return this.journal.getSummary(assertFamilyId(familyId))
  }

  getBabyInfoMutation(familyId: string, key: string): BabyInfoMutation | undefined {
    return this.journal.getMutation(assertFamilyId(familyId), key)
  }

  listUnlinkedBabyInfoArchives(rawRequest: unknown): BabyInfoArchivePage {
    return this.journal.listUnlinkedArchivePage(rawRequest)
  }

  commitBabyInfo(rawOperation: unknown): BabyInfoSettingsCommitResult {
    this.assertStorageWritable()
    try {
      return this.commitBabyInfoInternal(rawOperation)
    } catch (error) {
      throw this.normalizeStorageRecoveryError(error)
    }
  }

  private commitBabyInfoInternal(rawOperation: unknown): BabyInfoSettingsCommitResult {
    const operation = parseBabyInfoSettingsCommitOperation(rawOperation)
    let current = parseAppSettings(this.settings)

    if (operation.kind === 'family-transition') {
      this.recoverJournalProjection()
      current = parseAppSettings(this.settings)
      const next = this.projectFamily(current, operation.familyId)
      this.write(next)
      const summary = this.journal.getSummary(operation.familyId)
      return {
        kind: 'family-transition',
        settings: this.get(),
        babyInfo: summary.pendingCount > 0 ? 'pending' : 'unchanged',
        pendingCount: this.journal.getTotalPendingCount(),
        activePendingCount: summary.pendingCount,
        winner: summary.winner,
      }
    }

    if (operation.familyId !== current.familyId) {
      throw new BabyInfoSettingsCommitError('FAMILY_MISMATCH', 'baby info family mismatch')
    }

    if (operation.kind === 'user-edit') {
      // Reject malformed/cross-family input before recovery can write anything.
      // A valid user edit may then recover a prior journal-before-projection
      // interruption before deciding whether this pair is a new mutation.
      this.recoverJournalProjection()
      current = parseAppSettings(this.settings)
      if (operation.familyId !== current.familyId) {
        throw new BabyInfoSettingsCommitError('FAMILY_MISMATCH', 'baby info family mismatch')
      }
      const ordinarySettings = applyManagedSettingsSave(current, operation.settings)
      const changed = operation.babyName !== current.baby.name
        || operation.babyBirthdate !== current.baby.birthdate
      let mutation: BabyInfoMutation | undefined
      let winner: BabyInfoMutation | undefined
      let activePendingCount = 0
      let journalMutationDurable = false

      if (changed && operation.familyId) {
        const before = this.journal.getSummary(operation.familyId)
        const maximumClock = before.winner?.logicalClock ?? 0
        if (maximumClock >= Number.MAX_SAFE_INTEGER) {
          throw new Error('baby info logical clock exhausted')
        }
        const nowMs = Date.now()
        mutation = {
          mutationId: uuidv4(),
          familyId: operation.familyId,
          babyName: operation.babyName,
          babyBirthdate: operation.babyBirthdate,
          logicalClock: maximumClock + 1,
          updatedAt: new Date(nowMs).toISOString(),
          // firestore.rules requires this numeric shadow on every uploaded
          // mutation (validBabyMutationShape's `hasAll([...,'updatedAtMs',...])`);
          // without it, cloud writes for this mutation are denied outright.
          updatedAtMs: nowMs,
          authorId: ordinarySettings.profile.uid || 'local',
          origin: 'user',
        }
        canonicalBabyInfoMutationJson(mutation)
        const summary = this.journal.ingest(operation.familyId, [mutation], [])
        journalMutationDurable = true
        winner = summary.winner
        activePendingCount = summary.pendingCount
      } else if (operation.familyId) {
        const summary = this.journal.getSummary(operation.familyId)
        winner = summary.winner
        activePendingCount = summary.pendingCount
      }

      let settings = ordinarySettings
      if (changed) {
        settings = {
          ...ordinarySettings,
          baby: {
            ...ordinarySettings.baby,
            name: operation.babyName,
            birthdate: operation.babyBirthdate,
          },
          babyInfoSync: undefined,
          babyInfoJournal: this.projectionMetadata(operation.familyId, winner),
          babyInfoRevision: incrementBabyInfoRevision(ordinarySettings),
        }
      }
      if (changed || !sameValue(settings, current)) {
        try {
          this.write(settings)
        } catch (error) {
          if (journalMutationDurable) {
            throw new SettingsJournalMutationRecoveryError('user-edit', error)
          }
          throw error
        }
      }

      const pendingCount = this.journal.getTotalPendingCount()
      return {
        kind: 'user-edit',
        settings: this.get(),
        babyInfo: changed
          ? operation.familyId ? 'pending' : 'local-only'
          : pendingCount > 0 ? 'pending' : 'unchanged',
        mutation,
        pendingCount,
        activePendingCount,
        winner,
      }
    }

    const beforeSummary = this.journal.getSummary(operation.familyId)
    const summary = this.journal.ingest(
      operation.familyId,
      operation.discoveredMutations,
      operation.exactAcknowledgedMutationKeys,
    )
    const journalMutationDurable = beforeSummary.mutationCount !== summary.mutationCount
      || beforeSummary.pendingCount !== summary.pendingCount
    const metadata = this.projectionMetadata(operation.familyId, summary.winner)
    const projectionChanged = Boolean(summary.winner) && (
      current.baby.name !== summary.winner!.babyName
      || current.baby.birthdate !== summary.winner!.babyBirthdate
    )
    const metadataChanged = !sameValue(current.babyInfoJournal, metadata)
    if (projectionChanged || metadataChanged || current.babyInfoSync !== undefined) {
      try {
        this.write({
          ...current,
          baby: summary.winner
            ? {
                ...current.baby,
                name: summary.winner.babyName,
                birthdate: summary.winner.babyBirthdate,
              }
            : current.baby,
          babyInfoSync: undefined,
          babyInfoJournal: metadata,
          babyInfoRevision: incrementBabyInfoRevision(current),
        })
      } catch (error) {
        if (journalMutationDurable) {
          throw new SettingsJournalMutationRecoveryError('reconcile', error)
        }
        throw error
      }
    }
    const pendingCount = this.journal.getTotalPendingCount()
    return {
      kind: 'reconcile',
      settings: this.get(),
      babyInfo: pendingCount > 0 ? 'pending' : 'unchanged',
      pendingCount,
      activePendingCount: summary.pendingCount,
      winner: summary.winner,
    }
  }
}
