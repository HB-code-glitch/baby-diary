import { v5 as uuidv5 } from 'uuid'
import type {
  BabyInfoMutation,
  BabyInfoMutationOrigin,
  BabyInfoSyncState,
  BabyInfoUnlinkedArchive,
} from './types'
import { isValidMutationId } from './eventResolver'
import { isValidFamilyId } from './familyId'

const BABY_INFO_CONTENT_NAMESPACE = '6ba7b814-9dad-11d1-80b4-00c04fd430c8'
const BABY_INFO_LEGACY_NAMESPACE = '6ba7b815-9dad-11d1-80b4-00c04fd430c8'
const BABY_INFO_UNLINKED_ARCHIVE_NAMESPACE = '6ba7b816-9dad-11d1-80b4-00c04fd430c8'
const EXPLICIT_ZONE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const MUTATION_FIELDS = [
  'authorId',
  'babyBirthdate',
  'babyName',
  'familyId',
  'logicalClock',
  'mutationId',
  'origin',
  'updatedAt',
] as const

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isExplicitZoneTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && EXPLICIT_ZONE_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value))
}

function isSafeText(value: unknown, maxLength: number, allowEmpty = true): value is string {
  return typeof value === 'string'
    && value.length <= maxLength
    && (allowEmpty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function validateMutation(value: unknown): value is BabyInfoMutation {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== MUTATION_FIELDS.length || keys.some((key, index) => key !== MUTATION_FIELDS[index])) {
    return false
  }
  if (!isValidMutationId(value.mutationId)) return false
  if (!isValidFamilyId(value.familyId)) return false
  if (!isSafeText(value.babyName, 2_048)) return false
  if (!isSafeText(value.babyBirthdate, 128)) return false
  if (!Number.isSafeInteger(value.logicalClock) || (value.logicalClock as number) < 0) return false
  if (!isExplicitZoneTimestamp(value.updatedAt)) return false
  if (!isSafeText(value.authorId, 1_024, false)) return false
  if (value.origin !== 'user' && value.origin !== 'legacy-local' && value.origin !== 'legacy-cloud') return false
  if (value.origin === 'user') return (value.logicalClock as number) >= 1
  if (value.origin === 'legacy-local') return value.logicalClock === 0
  return true
}

/** Stable JSON containing every immutable baby-info mutation field. */
export function canonicalBabyInfoMutationJson(mutation: BabyInfoMutation): string {
  if (!validateMutation(mutation)) throw new Error('invalid baby info mutation')
  return JSON.stringify({
    mutationId: mutation.mutationId,
    familyId: mutation.familyId,
    babyName: mutation.babyName,
    babyBirthdate: mutation.babyBirthdate,
    logicalClock: mutation.logicalClock,
    updatedAt: mutation.updatedAt,
    authorId: mutation.authorId,
    origin: mutation.origin,
  })
}

/** Content-bound immutable identity; a reused UUID with another payload gets another key. */
export function getBabyInfoMutationKey(mutation: BabyInfoMutation): string {
  const canonical = canonicalBabyInfoMutationJson(mutation)
  const contentId = uuidv5(`baby-diary:baby-info-content:${canonical}`, BABY_INFO_CONTENT_NAMESPACE)
  return `baby-info:${mutation.mutationId}:${contentId}`
}

export function isValidBabyInfoMutationKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 160) return false
  const parts = value.split(':')
  return parts.length === 3
    && parts[0] === 'baby-info'
    && isValidMutationId(parts[1])
    && isValidMutationId(parts[2])
}

function originRank(origin: BabyInfoMutationOrigin): number {
  if (origin === 'legacy-cloud') return 0
  if (origin === 'legacy-local') return 1
  return 2
}

/** Positive means left is the deterministic visible winner. */
export function compareBabyInfoMutations(left: BabyInfoMutation, right: BabyInfoMutation): number {
  const leftCanonical = canonicalBabyInfoMutationJson(left)
  const rightCanonical = canonicalBabyInfoMutationJson(right)
  if (left.logicalClock !== right.logicalClock) return left.logicalClock < right.logicalClock ? -1 : 1

  const leftTime = Date.parse(left.updatedAt)
  const rightTime = Date.parse(right.updatedAt)
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1

  const rankOrder = originRank(left.origin) - originRank(right.origin)
  if (rankOrder !== 0) return rankOrder < 0 ? -1 : 1

  const keyOrder = compareStrings(getBabyInfoMutationKey(left), getBabyInfoMutationKey(right))
  if (keyOrder !== 0) return keyOrder
  return compareStrings(leftCanonical, rightCanonical)
}

export function resolveLatestBabyInfoMutation(
  mutations: readonly BabyInfoMutation[],
): BabyInfoMutation | undefined {
  let winner: BabyInfoMutation | undefined
  for (const mutation of mutations) {
    canonicalBabyInfoMutationJson(mutation)
    if (!winner || compareBabyInfoMutations(mutation, winner) > 0) winner = mutation
  }
  return winner
}

/**
 * Validates an explicit durable state fail-closed. Only exact duplicates are
 * removed; malformed state is never silently rewritten as empty.
 */
export function normalizeBabyInfoSyncState(value: unknown): BabyInfoSyncState {
  if (value === undefined) {
    return { version: 1, mutations: [], pendingMutationKeys: [] }
  }
  if (!isPlainRecord(value)
    || value.version !== 1
    || !Array.isArray(value.mutations)
    || !Array.isArray(value.pendingMutationKeys)) {
    throw new Error('invalid baby info sync state')
  }

  const mutations: BabyInfoMutation[] = []
  const canonicalSeen = new Set<string>()
  for (const candidate of value.mutations) {
    if (!validateMutation(candidate)) throw new Error('invalid baby info sync mutation')
    const canonical = canonicalBabyInfoMutationJson(candidate)
    if (canonicalSeen.has(canonical)) continue
    canonicalSeen.add(canonical)
    mutations.push(candidate)
  }

  const availableKeys = new Set(mutations.map(getBabyInfoMutationKey))
  const pendingMutationKeys: string[] = []
  const pendingSeen = new Set<string>()
  for (const candidate of value.pendingMutationKeys) {
    if (typeof candidate !== 'string' || !availableKeys.has(candidate)) {
      throw new Error('invalid baby info sync pending key')
    }
    if (pendingSeen.has(candidate)) continue
    pendingSeen.add(candidate)
    pendingMutationKeys.push(candidate)
  }

  return { version: 1, mutations, pendingMutationKeys }
}

function makeLegacyBabyInfoMutation(
  familyId: string,
  babyName: string,
  babyBirthdate: string,
  origin: Extract<BabyInfoMutationOrigin, 'legacy-local' | 'legacy-cloud'>,
): BabyInfoMutation | undefined {
  if (babyName === '' && babyBirthdate === '') return undefined
  const canonicalSource = JSON.stringify({ familyId, babyName, babyBirthdate, origin })
  return {
    mutationId: uuidv5(`baby-diary:baby-info-legacy:${canonicalSource}`, BABY_INFO_LEGACY_NAMESPACE),
    familyId,
    babyName,
    babyBirthdate,
    logicalClock: 0,
    updatedAt: '1970-01-01T00:00:00.000Z',
    authorId: origin,
    origin,
  }
}

export function makeLegacyLocalBabyInfoMutation(
  familyId: string,
  babyName: string,
  babyBirthdate: string,
): BabyInfoMutation | undefined {
  return makeLegacyBabyInfoMutation(familyId, babyName, babyBirthdate, 'legacy-local')
}

export function makeLegacyCloudBabyInfoMutation(
  familyId: string,
  babyName: string,
  babyBirthdate: string,
): BabyInfoMutation | undefined {
  return makeLegacyBabyInfoMutation(familyId, babyName, babyBirthdate, 'legacy-cloud')
}

export function getBabyInfoUnlinkedArchiveId(babyName: string, babyBirthdate: string): string {
  if (!isSafeText(babyName, 2_048) || !isSafeText(babyBirthdate, 128)) {
    throw new Error('invalid unlinked baby info archive values')
  }
  return uuidv5(
    `baby-diary:baby-info-unlinked:${JSON.stringify({ babyName, babyBirthdate })}`,
    BABY_INFO_UNLINKED_ARCHIVE_NAMESPACE,
  )
}

export function makeBabyInfoUnlinkedArchive(
  babyName: string,
  babyBirthdate: string,
  archivedAt = new Date().toISOString(),
): BabyInfoUnlinkedArchive | undefined {
  if (babyName === '' && babyBirthdate === '') return undefined
  if (!isExplicitZoneTimestamp(archivedAt)) throw new Error('invalid archive timestamp')
  return {
    archiveId: getBabyInfoUnlinkedArchiveId(babyName, babyBirthdate),
    babyName,
    babyBirthdate,
    archivedAt,
    source: 'legacy-unscoped',
  }
}

export function validateBabyInfoUnlinkedArchive(value: unknown): value is BabyInfoUnlinkedArchive {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value).sort()
  const expected = ['archiveId', 'archivedAt', 'babyBirthdate', 'babyName', 'source']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false
  if (!isValidMutationId(value.archiveId)
    || !isSafeText(value.babyName, 2_048)
    || !isSafeText(value.babyBirthdate, 128)
    || !isExplicitZoneTimestamp(value.archivedAt)
    || value.source !== 'legacy-unscoped') return false
  return value.archiveId === getBabyInfoUnlinkedArchiveId(value.babyName, value.babyBirthdate)
}

/**
 * Preserves a pair-only write made by a v0.3.8 client after an immutable winner
 * was already projected. Binding the UUID to the prior content key makes the
 * bridge deterministic across devices and prevents replay from growing history.
 */
export function makeLegacyCloudBridgeBabyInfoMutation(
  familyId: string,
  babyName: string,
  babyBirthdate: string,
  priorWinnerKey: string,
  priorWinner: BabyInfoMutation,
): BabyInfoMutation | undefined {
  canonicalBabyInfoMutationJson(priorWinner)
  if (!isValidFamilyId(familyId) || priorWinner.familyId !== familyId) {
    throw new Error('legacy cloud bridge family mismatch')
  }
  if (!isValidBabyInfoMutationKey(priorWinnerKey)
    || getBabyInfoMutationKey(priorWinner) !== priorWinnerKey) {
    throw new Error('legacy cloud bridge marker key mismatch')
  }
  if (babyName === priorWinner.babyName && babyBirthdate === priorWinner.babyBirthdate) {
    return undefined
  }
  if (priorWinner.logicalClock >= Number.MAX_SAFE_INTEGER) {
    throw new Error('legacy cloud bridge logical clock exhausted')
  }

  const canonicalSource = JSON.stringify({
    familyId,
    babyName,
    babyBirthdate,
    priorWinnerKey,
  })
  return {
    mutationId: uuidv5(
      `baby-diary:baby-info-legacy-cloud-bridge:${canonicalSource}`,
      BABY_INFO_LEGACY_NAMESPACE,
    ),
    familyId,
    babyName,
    babyBirthdate,
    logicalClock: priorWinner.logicalClock + 1,
    updatedAt: priorWinner.updatedAt,
    authorId: 'legacy-cloud-bridge',
    origin: 'legacy-cloud',
  }
}
