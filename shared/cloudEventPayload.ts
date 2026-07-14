import type { DiaryEvent, DiaryEventSyncMetadata } from './types'
import {
  buildEventSyncMetadata,
  canonicalEventJson,
  deriveAuthBoundEvent,
  getEventContentId,
  isValidEventId,
  isValidMutationId,
  validateDiaryEvent,
} from './eventResolver'

export const CLOUD_FUTURE_SKEW_MS = 5 * 60 * 1000

export interface ParsedCloudEventPayload {
  event: DiaryEvent
  docId: string
}

function assertValidEvent(event: DiaryEvent): void {
  const error = validateDiaryEvent(event)
  if (error) throw new Error(`invalid event data: ${error}`)
}

export function createEventSyncMetadata(
  event: Pick<DiaryEvent, 'id' | 'at' | 'createdAt' | 'updatedAt'>,
): DiaryEventSyncMetadata {
  return buildEventSyncMetadata(event)
}

export function eventMigrationSourceContentId(event: DiaryEvent): string | undefined {
  return event.migration?.kind === 'legacy-author-v1'
    ? event.migration.sourceContentId
    : undefined
}

export function isUploadReadyEvent(event: DiaryEvent, writerUid: string): boolean {
  if (writerUid.length === 0 || validateDiaryEvent(event) !== null) return false
  if (!isValidMutationId(event.mutationId)
    || event.author.uid !== writerUid
    || event.migration?.kind !== 'legacy-author-v1'
    || !event.sync) return false
  const expected = createEventSyncMetadata(event)
  return event.sync.version === 1
    && event.sync.encodedEventId === expected.encodedEventId
    && event.sync.eventAtMs === expected.eventAtMs
    && event.sync.createdAtMs === expected.createdAtMs
    && event.sync.updatedAtMs === expected.updatedAtMs
}

/**
 * Creates a deterministic auth-bound immutable derivative. The source object is
 * never modified; callers durably append the returned mutation before upload.
 */
export function deriveUploadReadyEvent(source: DiaryEvent, writerUid: string): DiaryEvent {
  assertValidEvent(source)
  if (writerUid.length === 0) throw new Error('writer uid is required')
  if (source.migration !== undefined && isUploadReadyEvent(source, writerUid)) return source
  if (source.migration !== undefined) throw new Error('event derivative cannot be rebound')

  return deriveAuthBoundEvent(source, writerUid)
}

function hasExactEventEnvelope(data: unknown): data is { event: DiaryEvent } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const keys = Object.keys(data)
  return keys.length === 1 && keys[0] === 'event'
}

function matchesDocumentIdentity(docId: string, event: DiaryEvent): boolean {
  if (isValidMutationId(event.mutationId)) {
    const encodedId = encodeURIComponent(event.id)
    const m2 = `m2|${encodedId}|${event.rev}|${event.mutationId}`
    const m3 = `${m2.replace(/^m2/, 'm3')}|${getEventContentId(event)}`
    return docId === m2 || docId === m3
  }
  return isValidEventId(event.id) && docId === `${event.id}_${event.rev}`
}

function boundedCloudClock(event: DiaryEvent, nowMs: number): boolean {
  const upper = nowMs + CLOUD_FUTURE_SKEW_MS
  if (event.rev > upper) return false
  if (!event.sync) return true // Grandfathered read-only cloud record.
  return event.sync.eventAtMs <= upper
    && event.sync.createdAtMs <= upper
    && event.sync.updatedAtMs <= upper
}

/** Strict decoder for the permanent `{ event }` cloud envelope. */
export function parseCloudEventPayload(
  docId: string,
  data: unknown,
  nowMs = Date.now(),
): ParsedCloudEventPayload | null {
  if (!hasExactEventEnvelope(data) || validateDiaryEvent(data.event) !== null) return null
  if (!Number.isSafeInteger(nowMs) || !matchesDocumentIdentity(docId, data.event)) return null
  if (!boundedCloudClock(data.event, nowMs)) return null
  return { event: data.event, docId }
}

/** Stable equality used for exact ACK after a durable derived mutation upload. */
export function cloudEventPayloadEquals(
  parsed: ParsedCloudEventPayload,
  expected: DiaryEvent,
): boolean {
  return parsed.docId === makeCloudEventDocId(expected)
    && canonicalEventJson(parsed.event) === canonicalEventJson(expected)
}

export function makeCloudEventDocId(event: DiaryEvent): string {
  assertValidEvent(event)
  if (isValidMutationId(event.mutationId)) {
    return `m3|${encodeURIComponent(event.id)}|${event.rev}|${event.mutationId}|${getEventContentId(event)}`
  }
  return `${event.id}_${event.rev}`
}
