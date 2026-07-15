import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { DiaryEvent, EventFamilyConfirmationResult } from '../../shared/types'
import { getEventStorageKey, validateDiaryEvent } from '../../shared/eventResolver'
import { isValidFamilyId } from '../../shared/familyId'
import { isKnownV038UpgradeFixtureEvent } from '../../shared/knownV038UpgradeFixtureEvent'
import {
  appendDurableFileSync,
  isDurableAppendCommittedError,
  isDurableAppendUncertainError,
  type DurableFileOps,
  type DurableWriteOptions,
} from './durableFs'

export type EventFamilyBindingResult = 'ok' | 'duplicate' | 'conflict' | 'error'
export type EventFamilyOwnershipIntegrity = 'ok' | 'uncertain'

export interface EventFamilyOwnershipOptions {
  dataDir: string
  fileOps?: DurableFileOps
  platform?: NodeJS.Platform
}

export type EventFamilyAdoptionResult = EventFamilyConfirmationResult

type OwnershipRecord =
  | { version: 1; type: 'adoption'; familyId: string }
  | { version: 1; type: 'bind'; key: string; familyId: string }

const MAX_STORAGE_KEY_LENGTH = 400_000
export const EVENT_FAMILY_OWNERSHIP_MARKER_FILE = 'event-family-ownership-initialized-v1.jsonl'
const INITIALIZATION_MARKER_TEXT = '{"version":1,"type":"event-family-ownership-initialized"}\n'
const SHA256_PATTERN = /^[a-f0-9]{64}$/

interface SidecarCheckpoint {
  version: 1
  type: 'sidecar-checkpoint'
  bytes: number
  records: number
  chainSha256: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseRecord(value: unknown): OwnershipRecord | null {
  if (!isPlainRecord(value) || value.version !== 1 || !isValidFamilyId(value.familyId)) return null
  const keys = Object.keys(value).sort().join(',')
  if (value.type === 'adoption' && keys === 'familyId,type,version') {
    return { version: 1, type: 'adoption', familyId: value.familyId }
  }
  if (value.type === 'bind'
    && keys === 'familyId,key,type,version'
    && typeof value.key === 'string'
    && value.key.length > 0
    && value.key.length <= MAX_STORAGE_KEY_LENGTH
    && !value.key.includes('\0')) {
    return { version: 1, type: 'bind', key: value.key, familyId: value.familyId }
  }
  return null
}

function parseCheckpoint(value: unknown): SidecarCheckpoint | null {
  if (!isPlainRecord(value)
    || value.version !== 1
    || value.type !== 'sidecar-checkpoint'
    || Object.keys(value).sort().join(',') !== 'bytes,chainSha256,records,type,version'
    || !Number.isSafeInteger(value.bytes)
    || (value.bytes as number) <= 0
    || !Number.isSafeInteger(value.records)
    || (value.records as number) <= 0
    || typeof value.chainSha256 !== 'string'
    || !SHA256_PATTERN.test(value.chainSha256)) return null
  return {
    version: 1,
    type: 'sidecar-checkpoint',
    bytes: value.bytes as number,
    records: value.records as number,
    chainSha256: value.chainSha256,
  }
}

function parseMarker(content: string): { valid: boolean; checkpoints: SidecarCheckpoint[] } {
  if (!content.endsWith('\n')) return { valid: false, checkpoints: [] }
  const lines = content.slice(0, -1).split('\n')
  if (lines.length < 1 || `${lines[0]}\n` !== INITIALIZATION_MARKER_TEXT) {
    return { valid: false, checkpoints: [] }
  }
  let checkpoint: SidecarCheckpoint | undefined
  const checkpoints: SidecarCheckpoint[] = []
  for (const line of lines.slice(1)) {
    let parsed: SidecarCheckpoint | null = null
    try {
      parsed = parseCheckpoint(JSON.parse(line))
    } catch {
      // Strict marker parsing: every complete line must be canonical JSON.
    }
    if (!parsed
      || (checkpoint !== undefined
        && (parsed.bytes <= checkpoint.bytes || parsed.records <= checkpoint.records))) {
      return { valid: false, checkpoints: [] }
    }
    checkpoint = parsed
    checkpoints.push(parsed)
  }
  return { valid: true, checkpoints }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const EMPTY_SIDECAR_CHAIN_SHA256 = sha256(Buffer.alloc(0))

function extendSidecarChain(previous: string, recordBytes: Uint8Array): string {
  return sha256(Buffer.concat([Buffer.from(previous, 'hex'), Buffer.from(recordBytes)]))
}

/**
 * Append-only ownership sidecar for immutable EventLog records.
 *
 * Event bytes stay in their original JSONL files. A corrupt or torn sidecar
 * therefore cannot erase records; it only makes unknown ownership fail closed.
 */
export class EventFamilyOwnership {
  readonly filePath: string
  readonly initializationMarkerPath: string
  private readonly durableWriteOptions: DurableWriteOptions
  private readonly bindings = new Map<string, string>()
  private readonly ambiguousKeys = new Set<string>()
  private loaded = false
  private adoptionFamilyId: string | undefined
  private currentIntegrity: EventFamilyOwnershipIntegrity = 'ok'
  private initializationMarkerPresent = false
  private sidecarBytes = 0
  private sidecarRecords = 0
  private sidecarChainSha256 = EMPTY_SIDECAR_CHAIN_SHA256

  constructor(options: EventFamilyOwnershipOptions) {
    this.filePath = path.join(options.dataDir, 'event-family-ownership-v1.jsonl')
    this.initializationMarkerPath = path.join(options.dataDir, EVENT_FAMILY_OWNERSHIP_MARKER_FILE)
    this.durableWriteOptions = {
      fs: options.fileOps,
      platform: options.platform,
    }
  }

  get integrity(): EventFamilyOwnershipIntegrity {
    this.load()
    return this.currentIntegrity
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    this.bindings.clear()
    this.ambiguousKeys.clear()
    this.adoptionFamilyId = undefined
    this.currentIntegrity = 'ok'
    this.initializationMarkerPresent = false
    this.sidecarBytes = 0
    this.sidecarRecords = 0
    this.sidecarChainSha256 = EMPTY_SIDECAR_CHAIN_SHA256

    let markerState: 'absent' | 'valid' | 'invalid' = 'absent'
    let markerCheckpoints: SidecarCheckpoint[] = []
    try {
      const markerContent = fs.readFileSync(this.initializationMarkerPath, 'utf8')
      const parsedMarker = parseMarker(markerContent)
      markerState = parsedMarker.valid ? 'valid' : 'invalid'
      markerCheckpoints = parsedMarker.checkpoints
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') markerState = 'invalid'
    }
    this.initializationMarkerPresent = markerState === 'valid'
    if (markerState === 'invalid') this.currentIntegrity = 'uncertain'

    let content: string
    try {
      content = fs.readFileSync(this.filePath, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (markerState !== 'absent') this.currentIntegrity = 'uncertain'
        return
      }
      this.currentIntegrity = 'uncertain'
      return
    }
    if (markerState !== 'valid') this.currentIntegrity = 'uncertain'
    if (content.length === 0) {
      this.currentIntegrity = 'uncertain'
      return
    }

    // Every committed record includes its newline in the fsynced append. A
    // non-newline suffix is an incomplete record and must never grant ownership.
    const hasTornSuffix = !content.endsWith('\n')
    const lines = content.split('\n')
    if (hasTornSuffix) {
      lines.pop()
      this.currentIntegrity = 'uncertain'
    }

    let completeBytes = 0
    let completeRecords = 0
    let completeChain = EMPTY_SIDECAR_CHAIN_SHA256
    let trustedRecords = 0
    const checkpointsByRecord = new Map(
      markerCheckpoints.map(checkpoint => [checkpoint.records, checkpoint] as const),
    )
    const completeLines: string[] = []
    for (const line of lines) {
      if (line.length === 0) continue
      const lineBytes = Buffer.from(`${line}\n`, 'utf8')
      completeLines.push(line)
      completeRecords += 1
      completeBytes += lineBytes.byteLength
      completeChain = extendSidecarChain(completeChain, lineBytes)
      const checkpoint = checkpointsByRecord.get(completeRecords)
      if (checkpoint
        && checkpoint.bytes === completeBytes
        && checkpoint.chainSha256 === completeChain) {
        trustedRecords = completeRecords
      }
    }

    const latestCheckpoint = markerCheckpoints.at(-1)
    const exactCheckpoint = markerState === 'valid'
      && !hasTornSuffix
      && latestCheckpoint !== undefined
      && trustedRecords === completeRecords
      && latestCheckpoint.records === completeRecords
      && latestCheckpoint.bytes === completeBytes
      && latestCheckpoint.chainSha256 === completeChain
    if (!exactCheckpoint) this.currentIntegrity = 'uncertain'

    // Only a prefix independently proven by a retained marker checkpoint may
    // grant ownership. Marker loss/corruption exposes no bindings at all;
    // truncation/torn writes retain only the last cryptographically proven
    // prefix while every new bind/adoption remains blocked.
    for (const line of completeLines.slice(0, trustedRecords)) {
      let parsed: OwnershipRecord | null = null
      try {
        parsed = parseRecord(JSON.parse(line))
      } catch {
        // A malformed complete line means the sidecar history is ambiguous.
      }
      if (!parsed) {
        this.currentIntegrity = 'uncertain'
        continue
      }

      if (parsed.type === 'adoption') {
        if (this.adoptionFamilyId === undefined) this.adoptionFamilyId = parsed.familyId
        else if (this.adoptionFamilyId !== parsed.familyId) this.currentIntegrity = 'uncertain'
        continue
      }

      const existing = this.bindings.get(parsed.key)
      if (existing === undefined && !this.ambiguousKeys.has(parsed.key)) {
        this.bindings.set(parsed.key, parsed.familyId)
      } else if (existing !== parsed.familyId) {
        this.bindings.delete(parsed.key)
        this.ambiguousKeys.add(parsed.key)
        this.currentIntegrity = 'uncertain'
      }
    }
    this.sidecarBytes = completeBytes
    this.sidecarRecords = completeRecords
    this.sidecarChainSha256 = completeChain
  }

  private ensureInitializationMarker(): boolean {
    this.load()
    if (this.currentIntegrity !== 'ok') return false
    if (this.initializationMarkerPresent) return true
    try {
      appendDurableFileSync(
        this.initializationMarkerPath,
        Buffer.from(INITIALIZATION_MARKER_TEXT, 'utf8'),
        this.durableWriteOptions,
      )
      this.initializationMarkerPresent = true
      return true
    } catch (error) {
      if (isDurableAppendCommittedError(error)) {
        this.initializationMarkerPresent = true
        return true
      }
      // Even a rolled-back first write can leave an empty marker inode. Do not
      // retry or create a sidecar in this process: the next load must diagnose
      // the partial initialization and remain fail-closed.
      this.currentIntegrity = 'uncertain'
      console.error('[EventFamilyOwnership] Durable initialization marker write failed:', error)
      return false
    }
  }

  private appendRecord(record: OwnershipRecord): boolean {
    this.load()
    if (this.currentIntegrity !== 'ok' || !this.ensureInitializationMarker()) return false
    const payload = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
    let sidecarCommitted = false
    try {
      appendDurableFileSync(
        this.filePath,
        payload,
        this.durableWriteOptions,
      )
      sidecarCommitted = true
    } catch (error) {
      if (isDurableAppendCommittedError(error)) sidecarCommitted = true
      if (isDurableAppendUncertainError(error)) this.currentIntegrity = 'uncertain'
      if (!sidecarCommitted) {
        console.error('[EventFamilyOwnership] Durable sidecar append failed:', error)
        return false
      }
    }

    const checkpoint: SidecarCheckpoint = {
      version: 1,
      type: 'sidecar-checkpoint',
      bytes: this.sidecarBytes + payload.byteLength,
      records: this.sidecarRecords + 1,
      chainSha256: extendSidecarChain(this.sidecarChainSha256, payload),
    }
    try {
      appendDurableFileSync(
        this.initializationMarkerPath,
        Buffer.from(`${JSON.stringify(checkpoint)}\n`, 'utf8'),
        this.durableWriteOptions,
      )
    } catch (error) {
      if (!isDurableAppendCommittedError(error)) {
        this.currentIntegrity = 'uncertain'
        console.error('[EventFamilyOwnership] Durable sidecar checkpoint append failed:', error)
        return false
      }
    }
    this.sidecarBytes = checkpoint.bytes
    this.sidecarRecords = checkpoint.records
    this.sidecarChainSha256 = checkpoint.chainSha256
    return true
  }

  private appendFailureStatus(): 'uncertain' | 'error' {
    return this.currentIntegrity === 'uncertain' ? 'uncertain' : 'error'
  }

  bind(event: DiaryEvent, familyId: string): EventFamilyBindingResult {
    this.load()
    if (this.currentIntegrity !== 'ok'
      || !isValidFamilyId(familyId)
      || validateDiaryEvent(event) !== null
      || isKnownV038UpgradeFixtureEvent(event)) return 'error'

    let key: string
    try {
      key = getEventStorageKey(event)
    } catch {
      return 'error'
    }
    if (this.ambiguousKeys.has(key)) return 'conflict'
    const existing = this.bindings.get(key)
    if (existing === familyId) return 'duplicate'
    if (existing !== undefined) return 'conflict'

    if (!this.appendRecord({ version: 1, type: 'bind', key, familyId })) return 'error'
    this.bindings.set(key, familyId)
    return 'ok'
  }

  familyOf(event: DiaryEvent): string | undefined {
    this.load()
    if (isKnownV038UpgradeFixtureEvent(event)) return undefined
    try {
      const key = getEventStorageKey(event)
      return this.ambiguousKeys.has(key) ? undefined : this.bindings.get(key)
    } catch {
      return undefined
    }
  }

  filterMutations(events: readonly DiaryEvent[], familyId: string): DiaryEvent[] {
    if (!isValidFamilyId(familyId)) return []
    return events.filter(event => this.familyOf(event) === familyId)
  }

  /** Unlinked mode may show only records with no ownership evidence at all. */
  filterUnboundMutations(events: readonly DiaryEvent[]): DiaryEvent[] {
    this.load()
    if (this.currentIntegrity !== 'ok') return []
    return events.filter(event => {
      if (isKnownV038UpgradeFixtureEvent(event)) return false
      try {
        const key = getEventStorageKey(event)
        return !this.ambiguousKeys.has(key) && !this.bindings.has(key)
      } catch {
        return false
      }
    })
  }

  confirmAndAdopt(familyId: string, events: readonly DiaryEvent[]): EventFamilyAdoptionResult {
    this.load()
    if (!isValidFamilyId(familyId)) return { status: 'error', adoptedCount: 0 }
    if (this.currentIntegrity !== 'ok') {
      return {
        status: 'uncertain',
        ...(this.adoptionFamilyId ? { adoptionFamilyId: this.adoptionFamilyId } : {}),
        adoptedCount: 0,
      }
    }

    if (this.adoptionFamilyId === undefined) {
      if (!this.appendRecord({ version: 1, type: 'adoption', familyId })) {
        return { status: this.appendFailureStatus(), adoptedCount: 0 }
      }
      this.adoptionFamilyId = familyId
    }

    if (this.adoptionFamilyId !== familyId) {
      return {
        status: 'different-family',
        adoptionFamilyId: this.adoptionFamilyId,
        adoptedCount: 0,
      }
    }

    let adoptedCount = 0
    for (const event of events) {
      if (validateDiaryEvent(event) !== null || isKnownV038UpgradeFixtureEvent(event)) continue
      if (this.familyOf(event) !== undefined) continue
      const result = this.bind(event, familyId)
      if (result === 'ok') adoptedCount += 1
      else if (result === 'error') {
        return {
          status: this.appendFailureStatus(),
          adoptionFamilyId: familyId,
          adoptedCount,
        }
      }
    }
    return { status: 'ok', adoptionFamilyId: familyId, adoptedCount }
  }
}
