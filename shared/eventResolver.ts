import type { DiaryEvent, EventType } from './types'
import { v5 as uuidv5 } from 'uuid'

const VALID_TYPE_LIST: EventType[] = [
  'pee', 'poop', 'temp', 'breast', 'formula', 'diary', 'message', 'sleep', 'growth',
]
const VALID_TYPES = new Set<EventType>(VALID_TYPE_LIST)

export const MUTATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const LEGACY_MUTATION_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
const CONTENT_ID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const MAX_ENCODED_EVENT_ID_LENGTH = 1_300
const MAX_CANONICAL_EVENT_LENGTH = 192_000
const EXPLICIT_ZONE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new Error('non-finite number')
      return JSON.stringify(value)
    case 'object': {
      const objectValue = value as object
      if (ancestors.has(objectValue)) throw new Error('cyclic value')
      ancestors.add(objectValue)
      try {
        if (Array.isArray(value)) {
          return `[${value.map(item => item === undefined ? 'null' : canonicalize(item, ancestors)).join(',')}]`
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error('non-plain object')
        }
        const record = value as Record<string, unknown>
        const entries = Object.keys(record)
          .filter(key => record[key] !== undefined)
          .sort(compareStrings)
          .map(key => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`)
        return `{${entries.join(',')}}`
      } finally {
        ancestors.delete(objectValue)
      }
    }
    default:
      throw new Error('unsupported value')
  }
}

/** Stable JSON independent of object insertion order. */
export function canonicalEventJson(event: DiaryEvent): string {
  return canonicalize(event, new Set())
}

export function isValidMutationId(value: unknown): value is string {
  return typeof value === 'string' && MUTATION_ID_PATTERN.test(value)
}

function isValidDateString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && EXPLICIT_ZONE_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value))
}

function parseDeterministicTimestamp(value: string): number {
  return isValidDateString(value) ? Date.parse(value) : Number.NaN
}

export function isValidEventId(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) return false
  if (/[/\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const encoded = encodeURIComponent(value)
    return encoded.length <= MAX_ENCODED_EVENT_ID_LENGTH
      && decodeURIComponent(encoded) === value
  } catch {
    return false
  }
}

/** Shared validation for renderer/cloud and main/JSONL trust boundaries. */
export function validateDiaryEvent(event: unknown): string | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'event must be an object'
  const value = event as Record<string, unknown>

  if (!isValidEventId(value.id)) return 'id must be a safe non-empty string'
  if (value.mutationId !== undefined && !isValidMutationId(value.mutationId)) {
    return 'mutationId must be a lowercase UUID v4 or migrated v5 when present'
  }
  if (typeof value.rev !== 'number' || !Number.isSafeInteger(value.rev) || value.rev < 1) {
    return 'rev must be a positive safe integer'
  }
  if (!isValidDateString(value.at)) return 'at must be a valid date string'
  if (typeof value.type !== 'string' || !VALID_TYPES.has(value.type as EventType)) {
    return `type must be one of: ${VALID_TYPE_LIST.join(', ')}`
  }
  if (typeof value.deleted !== 'boolean') return 'deleted must be a boolean'
  if (!isValidDateString(value.createdAt)) return 'createdAt must be a valid date string'
  if (!isValidDateString(value.updatedAt)) return 'updatedAt must be a valid date string'
  if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return 'data must be an object'
  if (!value.author || typeof value.author !== 'object' || Array.isArray(value.author)) return 'author must be an object'

  const author = value.author as Record<string, unknown>
  if (typeof author.uid !== 'string' || author.uid.length > 256) return 'author.uid must be a string'
  if (typeof author.name !== 'string' || author.name.length > 512) return 'author.name must be a string'
  if (author.role !== 'dad' && author.role !== 'mom') return 'author.role must be dad or mom'

  try {
    if (canonicalize(value.data, new Set()).length > 128_000) return 'data is too large'
  } catch {
    return 'data must be finite acyclic JSON'
  }
  try {
    if (canonicalize(value, new Set()).length > MAX_CANONICAL_EVENT_LENGTH) return 'event JSON is too large'
  } catch {
    return 'event must be finite acyclic JSON'
  }
  return null
}

/**
 * Gives a legacy mutation a stable content-derived identity for cloud migration.
 * The original event stays untouched, so append-only JSONL history is never rewritten.
 */
export function ensureEventMutationIdentity(event: DiaryEvent): DiaryEvent {
  if (event.mutationId !== undefined) return event
  const mutationId = uuidv5(`baby-diary:legacy-event:${canonicalEventJson(event)}`, LEGACY_MUTATION_NAMESPACE)
  return { ...event, mutationId }
}

/** Stable payload identity used to recover safely from a corrupt reused UUID. */
export function getEventContentId(event: DiaryEvent): string {
  return uuidv5(`baby-diary:event-content:${canonicalEventJson(event)}`, CONTENT_ID_NAMESPACE)
}

/**
 * Physical append identity. New records use their immutable UUID. Legacy
 * records include canonical content so existing same-id/rev variants survive
 * without a destructive on-disk migration.
 */
export function getEventMutationKey(event: DiaryEvent): string {
  if (isValidMutationId(event.mutationId)) {
    return `mutation:${encodeURIComponent(event.id)}:${event.rev}:${event.mutationId}`
  }
  return `legacy:${encodeURIComponent(event.id)}:${event.rev}:${canonicalEventJson(event)}`
}

/** Exact physical record identity; unlike mutation identity it preserves UUID payload collisions. */
export function getEventStorageKey(event: DiaryEvent): string {
  return `${getEventMutationKey(event)}:content:${getEventContentId(event)}`
}

/** Positive means `left` is the deterministic visible winner. */
export function compareEventMutations(left: DiaryEvent, right: DiaryEvent): number {
  if (left.rev !== right.rev) return left.rev < right.rev ? -1 : 1
  if (left.deleted !== right.deleted) return left.deleted ? 1 : -1

  const leftUpdatedAt = parseDeterministicTimestamp(left.updatedAt)
  const rightUpdatedAt = parseDeterministicTimestamp(right.updatedAt)
  const leftHasValidUpdatedAt = Number.isFinite(leftUpdatedAt)
  const rightHasValidUpdatedAt = Number.isFinite(rightUpdatedAt)
  if (leftHasValidUpdatedAt !== rightHasValidUpdatedAt) return leftHasValidUpdatedAt ? 1 : -1
  if (leftHasValidUpdatedAt && leftUpdatedAt !== rightUpdatedAt) {
    return leftUpdatedAt < rightUpdatedAt ? -1 : 1
  }

  const identityOrder = compareStrings(getEventMutationKey(left), getEventMutationKey(right))
  if (identityOrder !== 0) return identityOrder
  return compareStrings(canonicalEventJson(left), canonicalEventJson(right))
}

export function resolveLatestEvent(events: readonly DiaryEvent[]): DiaryEvent | undefined {
  let winner: DiaryEvent | undefined
  for (const event of events) {
    if (!winner || compareEventMutations(event, winner) > 0) winner = event
  }
  return winner
}

export function mergeResolvedEvent(list: readonly DiaryEvent[], incoming: DiaryEvent): DiaryEvent[] {
  const index = list.findIndex(event => event.id === incoming.id)
  if (index < 0) return [...list, incoming]
  if (compareEventMutations(incoming, list[index]) <= 0) return [...list]
  const next = [...list]
  next[index] = incoming
  return next
}
