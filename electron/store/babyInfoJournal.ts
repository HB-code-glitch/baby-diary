import * as fs from 'fs'
import * as path from 'path'
import type {
  BabyInfoJournalSummary,
  BabyInfoMutation,
  BabyInfoPendingPage,
  BabyInfoSyncState,
  BabyInfoUnlinkedArchive,
} from '../../shared/types'
import {
  canonicalBabyInfoMutationJson,
  compareBabyInfoMutations,
  getBabyInfoMutationKey,
  isValidBabyInfoMutationKey,
  normalizeBabyInfoSyncState,
  makeBabyInfoUnlinkedArchive,
  validateBabyInfoUnlinkedArchive,
} from '../../shared/babyInfoResolver'
import { assertFamilyId } from '../../shared/familyId'
import {
  getBabyInfoArchiveIdFromCursor,
  makeBabyInfoArchiveCursor,
  parseBabyInfoArchivePageRequest,
  type BabyInfoArchivePage,
  type BabyInfoArchivePageRequest,
} from '../../shared/babyInfoArchivePaging'
import {
  appendDurableFileSync,
  isDurableAppendUncertainError,
  truncateDurableFileSync,
  type DurableFileOps,
  type DurableWriteOptions,
} from './durableFs'
import { OrderedStringSet } from './orderedStringSet'

export const BABY_INFO_JOURNAL_FILE = 'baby-info-journal-v1.jsonl'
const MAX_PAGE_SIZE = 500
const MAX_IMPORT_ID_BYTES = 512

export class BabyInfoStorageUncertainError extends Error {
  readonly code = 'BABY_INFO_STORAGE_UNCERTAIN' as const
  readonly readOnly = true as const

  constructor() {
    super('Baby-info storage durability is uncertain; restart before reading cloud work or writing again.')
    this.name = 'BabyInfoStorageUncertainError'
  }
}

function newestArchiveOrderKey(archive: BabyInfoUnlinkedArchive): string {
  const canonical = new Date(Date.parse(archive.archivedAt)).toISOString()
  const reverseTimestamp = canonical.replace(/\d/g, digit => String(9 - Number(digit)))
  return `${reverseTimestamp}\u0000${archive.archiveId}`
}

interface MutationRecord {
  version: 1
  type: 'mutation'
  key: string
  mutation: BabyInfoMutation
}

interface AcknowledgementRecord {
  version: 1
  type: 'ack'
  familyId: string
  key: string
}

interface ImportRecord {
  version: 1
  type: 'import'
  sourceId: string
}

interface UnlinkedArchiveRecord {
  version: 1
  type: 'unlinked-archive'
  archive: BabyInfoUnlinkedArchive
}

type JournalRecord = MutationRecord | AcknowledgementRecord | ImportRecord | UnlinkedArchiveRecord

interface FamilyIndex {
  mutationCount: number
  pendingCount: number
  pendingKeys: OrderedStringSet
  winner?: BabyInfoMutation
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function validImportId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && new TextEncoder().encode(value).byteLength <= MAX_IMPORT_ID_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value)
}

export class BabyInfoJournal {
  private readonly journalPath: string
  private readonly mutationsByKey = new Map<string, BabyInfoMutation>()
  private readonly families = new Map<string, FamilyIndex>()
  private readonly acknowledgedKeys = new Set<string>()
  private readonly completedImports = new Set<string>()
  private readonly unlinkedArchivesById = new Map<string, BabyInfoUnlinkedArchive>()
  private unlinkedArchiveOrder = new OrderedStringSet()
  private readonly unlinkedArchiveOrderKeyById = new Map<string, string>()
  private readonly unlinkedArchiveIdByOrderKey = new Map<string, string>()
  private totalPendingCount = 0
  private tornOffset: number | undefined
  private needsSeparator = false
  private readonly strictReplay: boolean
  private readonly readOnlyBuffer: boolean
  private readonly durableOptions: DurableWriteOptions
  private storageUncertain = false

  constructor(
    userDataPath: string,
    options: {
      strict?: boolean
      sourceBuffer?: Uint8Array
      durableFs?: DurableFileOps
      platform?: NodeJS.Platform
    } = {},
  ) {
    this.journalPath = path.join(userDataPath, BABY_INFO_JOURNAL_FILE)
    this.strictReplay = options.strict ?? false
    this.readOnlyBuffer = options.sourceBuffer !== undefined
    this.durableOptions = { fs: options.durableFs, platform: options.platform }
    if (options.sourceBuffer !== undefined) {
      this.load(Buffer.from(options.sourceBuffer))
      return
    }
    if (!fs.existsSync(this.journalPath)) {
      appendDurableFileSync(this.journalPath, Buffer.alloc(0), this.durableOptions)
    }
    this.load()
  }

  private resetIndexes(): void {
    this.mutationsByKey.clear()
    this.families.clear()
    this.acknowledgedKeys.clear()
    this.completedImports.clear()
    this.unlinkedArchivesById.clear()
    this.unlinkedArchiveOrder = new OrderedStringSet()
    this.unlinkedArchiveOrderKeyById.clear()
    this.unlinkedArchiveIdByOrderKey.clear()
    this.totalPendingCount = 0
    this.tornOffset = undefined
    this.needsSeparator = false
  }

  private assertStorageWritable(): void {
    if (this.storageUncertain) throw new BabyInfoStorageUncertainError()
    if (this.readOnlyBuffer) throw new Error('buffer-backed baby info journal is read-only')
  }

  private load(sourceBuffer?: Buffer): void {
    if (sourceBuffer === undefined && !fs.existsSync(this.journalPath)) return
    const content = sourceBuffer ?? fs.readFileSync(this.journalPath)
    let offset = 0
    while (offset < content.byteLength) {
      const newline = content.indexOf(0x0a, offset)
      const terminated = newline >= 0
      const end = terminated ? newline : content.byteLength
      const raw = content.subarray(offset, end).toString('utf8')
      if (raw.length === 0) {
        offset = terminated ? end + 1 : end
        continue
      }

      let candidate: unknown
      try {
        candidate = JSON.parse(raw)
      } catch {
        if (!this.strictReplay && !terminated && end === content.byteLength) {
          this.tornOffset = offset
          return
        }
        throw new Error(`baby info journal is corrupt at byte ${offset}`)
      }

      try {
        this.applyRecord(this.parseRecord(candidate))
      } catch (error) {
        throw new Error(
          `baby info journal is corrupt at byte ${offset}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      offset = terminated ? end + 1 : end
      if (!terminated) this.needsSeparator = true
    }
  }

  private parseRecord(value: unknown): JournalRecord {
    if (!isRecord(value) || value.version !== 1 || typeof value.type !== 'string') {
      throw new Error('invalid record envelope')
    }
    if (value.type === 'mutation') {
      if (!exactKeys(value, ['version', 'type', 'key', 'mutation']) || typeof value.key !== 'string') {
        throw new Error('invalid mutation record')
      }
      canonicalBabyInfoMutationJson(value.mutation as BabyInfoMutation)
      const mutation = value.mutation as BabyInfoMutation
      assertFamilyId(mutation.familyId)
      if (getBabyInfoMutationKey(mutation) !== value.key) throw new Error('mutation key mismatch')
      return { version: 1, type: 'mutation', key: value.key, mutation }
    }
    if (value.type === 'ack') {
      if (!exactKeys(value, ['version', 'type', 'familyId', 'key']) || typeof value.key !== 'string') {
        throw new Error('invalid acknowledgement record')
      }
      return {
        version: 1,
        type: 'ack',
        familyId: assertFamilyId(value.familyId),
        key: value.key,
      }
    }
    if (value.type === 'import') {
      if (!exactKeys(value, ['version', 'type', 'sourceId']) || !validImportId(value.sourceId)) {
        throw new Error('invalid import record')
      }
      return { version: 1, type: 'import', sourceId: value.sourceId }
    }
    if (value.type === 'unlinked-archive') {
      if (!exactKeys(value, ['version', 'type', 'archive'])
        || !validateBabyInfoUnlinkedArchive(value.archive)) {
        throw new Error('invalid unlinked archive record')
      }
      return { version: 1, type: 'unlinked-archive', archive: value.archive }
    }
    throw new Error('unknown record type')
  }

  private applyRecord(record: JournalRecord): void {
    if (record.type === 'mutation') {
      const existing = this.mutationsByKey.get(record.key)
      if (existing) {
        if (canonicalBabyInfoMutationJson(existing) !== canonicalBabyInfoMutationJson(record.mutation)) {
          throw new Error('content-bound mutation collision')
        }
        return
      }
      this.mutationsByKey.set(record.key, record.mutation)
      const family = this.families.get(record.mutation.familyId) ?? {
        mutationCount: 0,
        pendingCount: 0,
        pendingKeys: new OrderedStringSet(),
      }
      family.mutationCount += 1
      family.pendingCount += 1
      family.pendingKeys.add(record.key)
      this.totalPendingCount += 1
      if (!family.winner || compareBabyInfoMutations(record.mutation, family.winner) > 0) {
        family.winner = record.mutation
      }
      this.families.set(record.mutation.familyId, family)
      return
    }
    if (record.type === 'ack') {
      const mutation = this.mutationsByKey.get(record.key)
      if (!mutation || mutation.familyId !== record.familyId) {
        throw new Error('acknowledgement references unknown mutation')
      }
      if (!this.acknowledgedKeys.has(record.key)) {
        this.acknowledgedKeys.add(record.key)
        const family = this.families.get(record.familyId)!
        if (!family.pendingKeys.delete(record.key)) {
          throw new Error('acknowledgement pending index mismatch')
        }
        family.pendingCount -= 1
        this.totalPendingCount -= 1
      }
      return
    }
    if (record.type === 'import') {
      this.completedImports.add(record.sourceId)
      return
    }
    const existing = this.unlinkedArchivesById.get(record.archive.archiveId)
    if (existing) {
      if (existing.babyName !== record.archive.babyName
        || existing.babyBirthdate !== record.archive.babyBirthdate
        || existing.source !== record.archive.source) {
        throw new Error('unlinked archive identity collision')
      }
      return
    }
    this.unlinkedArchivesById.set(record.archive.archiveId, record.archive)
    const orderKey = newestArchiveOrderKey(record.archive)
    this.unlinkedArchiveOrder.add(orderKey)
    this.unlinkedArchiveOrderKeyById.set(record.archive.archiveId, orderKey)
    this.unlinkedArchiveIdByOrderKey.set(orderKey, record.archive.archiveId)
  }

  private repairTornTail(): void {
    if (this.tornOffset !== undefined) {
      truncateDurableFileSync(this.journalPath, this.tornOffset, this.durableOptions)
      this.tornOffset = undefined
      return
    }
    if (this.needsSeparator) {
      appendDurableFileSync(this.journalPath, Buffer.from('\n', 'utf8'), this.durableOptions)
      this.needsSeparator = false
    }
  }

  private appendRecords(records: readonly JournalRecord[]): void {
    this.assertStorageWritable()
    if (records.length === 0) return
    const payload = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')
    try {
      this.repairTornTail()
      appendDurableFileSync(this.journalPath, payload, this.durableOptions)
    } catch (error) {
      // The durable primitive either restored the exact pre-append prefix or
      // explicitly reported that it could not confirm rollback. Never ingest
      // bytes from the failed attempt into this process's memory.
      if (isDurableAppendUncertainError(error)) this.storageUncertain = true
      throw error
    }
    for (const record of records) this.applyRecord(record)
  }

  ingest(
    familyIdValue: string,
    mutations: readonly BabyInfoMutation[],
    exactAcknowledgedMutationKeys: readonly string[],
  ): BabyInfoJournalSummary {
    this.assertStorageWritable()
    const familyId = assertFamilyId(familyIdValue)
    const records: JournalRecord[] = []
    const appendedMutations = new Map<string, BabyInfoMutation>()

    for (const mutation of mutations) {
      canonicalBabyInfoMutationJson(mutation)
      if (mutation.familyId !== familyId) throw new Error('baby info mutation family mismatch')
      const key = getBabyInfoMutationKey(mutation)
      const existing = appendedMutations.get(key) ?? this.mutationsByKey.get(key)
      if (existing) {
        if (canonicalBabyInfoMutationJson(existing) !== canonicalBabyInfoMutationJson(mutation)) {
          throw new Error('content-bound mutation collision')
        }
        continue
      }
      appendedMutations.set(key, mutation)
      records.push({ version: 1, type: 'mutation', key, mutation })
    }

    const acknowledgementSeen = new Set<string>()
    for (const key of exactAcknowledgedMutationKeys) {
      if (acknowledgementSeen.has(key)) continue
      acknowledgementSeen.add(key)
      const mutation = appendedMutations.get(key) ?? this.mutationsByKey.get(key)
      if (!mutation) throw new Error('acknowledgement references unknown mutation')
      if (mutation.familyId !== familyId) throw new Error('acknowledgement family mismatch')
      if (!this.acknowledgedKeys.has(key)) {
        records.push({ version: 1, type: 'ack', familyId, key })
      }
    }

    this.appendRecords(records)
    return this.getSummary(familyId)
  }

  importLegacyState(sourceId: string, rawState: unknown): void {
    this.assertStorageWritable()
    if (!validImportId(sourceId)) throw new Error('legacy import id is invalid')
    if (this.completedImports.has(sourceId)) return
    const state: BabyInfoSyncState = normalizeBabyInfoSyncState(rawState)
    const pending = new Set(state.pendingMutationKeys)
    const byFamily = new Map<string, BabyInfoMutation[]>()
    for (const mutation of state.mutations) {
      const items = byFamily.get(mutation.familyId) ?? []
      items.push(mutation)
      byFamily.set(mutation.familyId, items)
    }
    for (const [familyId, mutations] of Array.from(byFamily.entries())) {
      const acknowledged = mutations
        .map(getBabyInfoMutationKey)
        .filter(key => !pending.has(key))
      this.ingest(familyId, mutations, acknowledged)
    }
    this.appendRecords([{ version: 1, type: 'import', sourceId }])
  }

  hasCompletedImport(sourceId: string): boolean {
    return this.completedImports.has(sourceId)
  }

  archiveUnlinkedPair(
    babyName: string,
    babyBirthdate: string,
    archivedAt = new Date().toISOString(),
  ): BabyInfoUnlinkedArchive | undefined {
    this.assertStorageWritable()
    const archive = makeBabyInfoUnlinkedArchive(babyName, babyBirthdate, archivedAt)
    if (!archive) return undefined
    const existing = this.unlinkedArchivesById.get(archive.archiveId)
    if (existing) return existing
    this.appendRecords([{ version: 1, type: 'unlinked-archive', archive }])
    return archive
  }

  listUnlinkedArchivePage(rawRequest: BabyInfoArchivePageRequest | unknown): BabyInfoArchivePage {
    const request = parseBabyInfoArchivePageRequest(rawRequest)
    let afterKey: string | undefined
    if (request.cursor) {
      const archiveId = getBabyInfoArchiveIdFromCursor(request.cursor)
      afterKey = this.unlinkedArchiveOrderKeyById.get(archiveId)
      if (!afterKey) throw new Error('baby info archive page cursor is unknown')
    }
    const selectedWithLookahead = this.unlinkedArchiveOrder.valuesAfter(afterKey, request.limit + 1)
    const selected = selectedWithLookahead.slice(0, request.limit)
    const items = selected.map(orderKey => {
      const archiveId = this.unlinkedArchiveIdByOrderKey.get(orderKey)!
      return { ...this.unlinkedArchivesById.get(archiveId)! }
    })
    const hasMore = selectedWithLookahead.length > request.limit
    return {
      items,
      ...(hasMore
        ? { nextCursor: makeBabyInfoArchiveCursor(items[items.length - 1].archiveId) }
        : {}),
    }
  }

  /** True for any durable mutation, acknowledgement, or completed import marker. */
  hasAnyRecords(): boolean {
    return this.mutationsByKey.size > 0
      || this.acknowledgedKeys.size > 0
      || this.completedImports.size > 0
      || this.unlinkedArchivesById.size > 0
  }

  getSummary(familyIdValue: string): BabyInfoJournalSummary {
    const familyId = assertFamilyId(familyIdValue)
    const family = this.families.get(familyId)
    return {
      familyId,
      mutationCount: family?.mutationCount ?? 0,
      pendingCount: family?.pendingCount ?? 0,
      totalPendingCount: this.totalPendingCount,
      winner: family?.winner,
    }
  }

  listPending(
    familyIdValue: string,
    options: { limit: number; afterKey?: string },
  ): BabyInfoPendingPage {
    if (this.storageUncertain) throw new BabyInfoStorageUncertainError()
    const familyId = assertFamilyId(familyIdValue)
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_PAGE_SIZE) {
      throw new Error(`baby info pending page limit must be between 1 and ${MAX_PAGE_SIZE}`)
    }
    if (options.afterKey !== undefined && !isValidBabyInfoMutationKey(options.afterKey)) {
      throw new Error('baby info pending cursor is invalid')
    }
    const selectedWithLookahead = this.families.get(familyId)?.pendingKeys.valuesAfter(
      options.afterKey,
      options.limit + 1,
    ) ?? []
    const selected = selectedWithLookahead.slice(0, options.limit)
    const items = selected.map(key => this.mutationsByKey.get(key)!)
    const hasMore = selectedWithLookahead.length > options.limit
    return {
      items,
      nextCursor: hasMore ? selected[selected.length - 1] : undefined,
    }
  }

  getTotalPendingCount(): number {
    return this.totalPendingCount
  }

  getMutation(familyIdValue: string, key: string): BabyInfoMutation | undefined {
    const familyId = assertFamilyId(familyIdValue)
    if (!isValidBabyInfoMutationKey(key)) throw new Error('baby info mutation key is invalid')
    const mutation = this.mutationsByKey.get(key)
    return mutation?.familyId === familyId ? mutation : undefined
  }
}

/** Strictly replays exactly the bytes supplied by a verified snapshot reader. */
export function parseBabyInfoJournalBuffer(bytes: Uint8Array): BabyInfoJournal {
  return new BabyInfoJournal('', { strict: true, sourceBuffer: bytes })
}
