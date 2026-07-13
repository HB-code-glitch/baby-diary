import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { v4 as uuidv4 } from 'uuid'
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
  parseBabyInfoSettingsCommitOperation,
  type DeepPartial,
} from '../../shared/babyInfoSettingsCommit'
import {
  canonicalBabyInfoMutationJson,
  getBabyInfoMutationKey,
  makeLegacyLocalBabyInfoMutation,
  normalizeBabyInfoSyncState,
} from '../../shared/babyInfoResolver'
import { assertFamilyId } from '../../shared/familyId'
import { BabyInfoJournal } from './babyInfoJournal'
import { atomicReplaceFileSync } from './durableFs'

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

function mergeDefaults(parsed: AppSettings): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    baby: { ...DEFAULT_SETTINGS.baby, ...(parsed.baby ?? {}) },
    profile: { ...DEFAULT_SETTINGS.profile, ...(parsed.profile ?? {}) },
    firebase: parsed.firebase ?? DEFAULT_SETTINGS.firebase,
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
    || (record.afterKey !== undefined && typeof record.afterKey !== 'string')) {
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
  private settings: AppSettings = { ...DEFAULT_SETTINGS }
  private readonly journal: BabyInfoJournal

  constructor(userDataPath: string) {
    this.settingsPath = path.join(userDataPath, 'settings.json')
    this.load()
    this.journal = new BabyInfoJournal(userDataPath)
    this.recoverJournalProjection()
  }

  private load(): void {
    if (!fs.existsSync(this.settingsPath)) return
    let raw: string
    try {
      raw = fs.readFileSync(this.settingsPath, 'utf8')
    } catch {
      return
    }

    const parsed = tryParse(raw)
    if (parsed !== null) {
      this.settings = mergeDefaults(parsed)
      return
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${this.settingsPath}.corrupt-${timestamp}.bak`
    try {
      fs.copyFileSync(this.settingsPath, backupPath)
      console.error(`[Settings] Corrupt settings.json - saved backup to ${backupPath}`)
    } catch (error) {
      console.error('[Settings] Could not write corrupt-settings backup:', error)
    }

    const restored = this.tryRestoreFromBackups(path.join(path.dirname(this.settingsPath), 'backups'))
    if (restored !== null) {
      this.settings = restored
      return
    }
    this.settings = { ...DEFAULT_SETTINGS }
  }

  private tryRestoreFromBackups(backupsDir: string): AppSettings | null {
    if (!fs.existsSync(backupsDir)) return null
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(backupsDir, { withFileTypes: true })
    } catch {
      return null
    }
    const directories = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
      .reverse()
    for (const directory of directories) {
      const candidate = path.join(backupsDir, directory, 'settings.json')
      try {
        if (!fs.existsSync(candidate)) continue
        const parsed = tryParse(fs.readFileSync(candidate, 'utf8'))
        if (parsed !== null) return mergeDefaults(parsed)
      } catch {
        // Continue to the next independently persisted snapshot.
      }
    }
    return null
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

  private write(settings: AppSettings): void {
    const content = Buffer.from(JSON.stringify(settings, null, 2), 'utf8')
    try {
      atomicReplaceFileSync(this.settingsPath, content)
    } catch (error) {
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

  /**
   * Import the legacy settings source only after the journal is durable, then
   * recover a possibly interrupted settings projection from the journal index.
   */
  private recoverJournalProjection(): void {
    const current = parseAppSettings(this.settings)
    let sourceRemoved = false

    if (current.babyInfoSync !== undefined) {
      const sourceId = legacyImportId(current.babyInfoSync)
      this.journal.importLegacyState(sourceId, current.babyInfoSync)
      sourceRemoved = true
    }

    let winner: BabyInfoMutation | undefined
    if (current.familyId) {
      assertFamilyId(current.familyId)
      let summary = this.journal.getSummary(current.familyId)
      if (summary.mutationCount === 0 && current.babyInfoSync === undefined) {
        const legacy = makeLegacyLocalBabyInfoMutation(
          current.familyId,
          current.baby.name,
          current.baby.birthdate,
        )
        if (legacy) summary = this.journal.ingest(current.familyId, [legacy], [])
      }
      winner = summary.winner
    }

    const metadata = this.projectionMetadata(current.familyId, winner)
    const pairChanged = Boolean(winner) && (
      current.baby.name !== winner!.babyName
      || current.baby.birthdate !== winner!.babyBirthdate
    )
    const metadataChanged = !sameValue(current.babyInfoJournal, metadata)
    if (!sourceRemoved && !pairChanged && !metadataChanged) return

    const next: AppSettings = {
      ...current,
      baby: winner
        ? { ...current.baby, name: winner.babyName, birthdate: winner.babyBirthdate }
        : current.baby,
      babyInfoSync: undefined,
      babyInfoJournal: metadata,
      babyInfoRevision: incrementBabyInfoRevision(current),
    }
    this.write(next)
  }

  save(settings: AppSettings): AppSettings {
    this.load()
    this.recoverJournalProjection()
    const next = applyManagedSettingsSave(this.settings, settings)
    this.write(next)
    return this.get()
  }

  merge(partial: DeepPartial<AppSettings>): AppSettings {
    this.load()
    this.recoverJournalProjection()
    const next = applyManagedSettingsMerge(this.settings, partial)
    this.write(next)
    return this.get()
  }

  listPendingBabyInfo(rawRequest: unknown): BabyInfoPendingPage {
    const request = parsePendingPageRequest(rawRequest)
    return this.journal.listPending(request.familyId, {
      limit: request.limit,
      afterKey: request.afterKey,
    })
  }

  getBabyInfoSummary(familyId: string): BabyInfoJournalSummary {
    return this.journal.getSummary(assertFamilyId(familyId))
  }

  commitBabyInfo(rawOperation: unknown): BabyInfoSettingsCommitResult {
    this.load()
    const operation = parseBabyInfoSettingsCommitOperation(rawOperation)
    let current = parseAppSettings(this.settings)

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
      const changed = operation.babyName !== current.baby.name
        || operation.babyBirthdate !== current.baby.birthdate
      let mutation: BabyInfoMutation | undefined
      let winner: BabyInfoMutation | undefined
      let activePendingCount = 0

      if (changed && operation.familyId) {
        const before = this.journal.getSummary(operation.familyId)
        const maximumClock = before.winner?.logicalClock ?? 0
        if (maximumClock >= Number.MAX_SAFE_INTEGER) {
          throw new Error('baby info logical clock exhausted')
        }
        mutation = {
          mutationId: uuidv4(),
          familyId: operation.familyId,
          babyName: operation.babyName,
          babyBirthdate: operation.babyBirthdate,
          logicalClock: maximumClock + 1,
          updatedAt: new Date().toISOString(),
          authorId: current.profile.uid || 'local',
          origin: 'user',
        }
        canonicalBabyInfoMutationJson(mutation)
        const summary = this.journal.ingest(operation.familyId, [mutation], [])
        winner = summary.winner
        activePendingCount = summary.pendingCount
      } else if (operation.familyId) {
        const summary = this.journal.getSummary(operation.familyId)
        winner = summary.winner
        activePendingCount = summary.pendingCount
      }

      let settings = current
      if (changed) {
        settings = {
          ...current,
          baby: {
            ...current.baby,
            name: operation.babyName,
            birthdate: operation.babyBirthdate,
          },
          babyInfoSync: undefined,
          babyInfoJournal: this.projectionMetadata(operation.familyId, winner),
          babyInfoRevision: incrementBabyInfoRevision(current),
        }
        this.write(settings)
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

    const summary = this.journal.ingest(
      operation.familyId,
      operation.discoveredMutations,
      operation.exactAcknowledgedMutationKeys,
    )
    const metadata = this.projectionMetadata(operation.familyId, summary.winner)
    const projectionChanged = Boolean(summary.winner) && (
      current.baby.name !== summary.winner!.babyName
      || current.baby.birthdate !== summary.winner!.babyBirthdate
    )
    const metadataChanged = !sameValue(current.babyInfoJournal, metadata)
    if (projectionChanged || metadataChanged || current.babyInfoSync !== undefined) {
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
