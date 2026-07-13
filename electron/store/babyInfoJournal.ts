import * as fs from 'fs'
import * as path from 'path'
import type {
  BabyInfoJournalSummary,
  BabyInfoMutation,
  BabyInfoPendingPage,
  BabyInfoSyncState,
} from '../../shared/types'
import {
  canonicalBabyInfoMutationJson,
  compareBabyInfoMutations,
  getBabyInfoMutationKey,
  isValidBabyInfoMutationKey,
  normalizeBabyInfoSyncState,
} from '../../shared/babyInfoResolver'
import { assertFamilyId } from '../../shared/familyId'
import { appendDurableFileSync, truncateDurableFileSync } from './durableFs'
import { OrderedStringSet } from './orderedStringSet'

export const BABY_INFO_JOURNAL_FILE = 'baby-info-journal-v1.jsonl'
const MAX_PAGE_SIZE = 500
const MAX_IMPORT_ID_BYTES = 512

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

type JournalRecord = MutationRecord | AcknowledgementRecord | ImportRecord

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
  private totalPendingCount = 0
  private tornOffset: number | undefined
  private needsSeparator = false
  private readonly strictReplay: boolean

  constructor(userDataPath: string, options: { strict?: boolean } = {}) {
    this.journalPath = path.join(userDataPath, BABY_INFO_JOURNAL_FILE)
    this.strictReplay = options.strict ?? false
    if (!fs.existsSync(this.journalPath)) {
      appendDurableFileSync(this.journalPath, Buffer.alloc(0))
    }
    this.load()
  }

  private load(): void {
    if (!fs.existsSync(this.journalPath)) return
    const content = fs.readFileSync(this.journalPath)
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
    this.completedImports.add(record.sourceId)
  }

  private repairTornTail(): void {
    if (this.tornOffset !== undefined) {
      truncateDurableFileSync(this.journalPath, this.tornOffset)
      this.tornOffset = undefined
      return
    }
    if (this.needsSeparator) {
      appendDurableFileSync(this.journalPath, Buffer.from('\n', 'utf8'))
      this.needsSeparator = false
    }
  }

  private appendRecords(records: readonly JournalRecord[]): void {
    if (records.length === 0) return
    this.repairTornTail()
    const payload = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')
    appendDurableFileSync(this.journalPath, payload)
    for (const record of records) this.applyRecord(record)
  }

  ingest(
    familyIdValue: string,
    mutations: readonly BabyInfoMutation[],
    exactAcknowledgedMutationKeys: readonly string[],
  ): BabyInfoJournalSummary {
    const familyId = assertFamilyId(familyIdValue)
    const records: JournalRecord[] = []
    const available = new Map(this.mutationsByKey)

    for (const mutation of mutations) {
      canonicalBabyInfoMutationJson(mutation)
      if (mutation.familyId !== familyId) throw new Error('baby info mutation family mismatch')
      const key = getBabyInfoMutationKey(mutation)
      const existing = available.get(key)
      if (existing) {
        if (canonicalBabyInfoMutationJson(existing) !== canonicalBabyInfoMutationJson(mutation)) {
          throw new Error('content-bound mutation collision')
        }
        continue
      }
      available.set(key, mutation)
      records.push({ version: 1, type: 'mutation', key, mutation })
    }

    const acknowledgementSeen = new Set<string>()
    for (const key of exactAcknowledgedMutationKeys) {
      if (acknowledgementSeen.has(key)) continue
      acknowledgementSeen.add(key)
      const mutation = available.get(key)
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

  /** True for any durable mutation, acknowledgement, or completed import marker. */
  hasAnyRecords(): boolean {
    return this.mutationsByKey.size > 0
      || this.acknowledgedKeys.size > 0
      || this.completedImports.size > 0
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
