import { describe, expect, it } from 'vitest'
import type { DiaryEvent } from '../shared/types'
import {
  CLOUD_FUTURE_SKEW_MS,
  createEventSyncMetadata,
  deriveUploadReadyEvent,
  eventMigrationSourceContentId,
  isUploadReadyEvent,
  makeCloudEventDocId,
  parseCloudEventPayload,
} from '../shared/cloudEventPayload'
import { getEventContentId } from '../shared/eventResolver'

const NOW = Date.parse('2026-07-13T12:00:00.000Z')
const WRITER_UID = 'firebase-writer-uid'

function event(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  return {
    id: 'event-1',
    mutationId: '11111111-1111-4111-8111-111111111111',
    type: 'temp',
    at: '2026-07-13T10:00:00.000Z',
    data: { celsius: 38.2 },
    author: { uid: WRITER_UID, name: 'Parent', role: 'mom' },
    createdAt: '2026-07-13T10:00:00.000Z',
    updatedAt: '2026-07-13T10:00:00.000Z',
    rev: 1,
    deleted: false,
    ...overrides,
  }
}

describe('cloud event transport payload', () => {
  it('binds native modern writes with exact bounded timestamp shadows inside { event }', () => {
    const source = event()
    const ready = { ...source, sync: createEventSyncMetadata(source) }

    expect(isUploadReadyEvent(ready, WRITER_UID)).toBe(true)
    expect(ready.sync).toEqual({
      version: 1,
      encodedEventId: 'event-1',
      eventAtMs: Date.parse(source.at),
      createdAtMs: Date.parse(source.createdAt),
      updatedAtMs: Date.parse(source.updatedAt),
    })
    const docId = makeCloudEventDocId(ready)
    expect(parseCloudEventPayload(docId, { event: ready }, NOW)?.event).toEqual(ready)
    expect(parseCloudEventPayload(docId, { event: ready, writerUid: WRITER_UID }, NOW)).toBeNull()

    const clockPoison = { ...ready, rev: NOW + CLOUD_FUTURE_SKEW_MS + 1 }
    expect(parseCloudEventPayload(
      makeCloudEventDocId(clockPoison),
      { event: clockPoison },
      NOW,
    )).toBeNull()
  })

  it('migrates a pre-auth/foreign local author without rewriting or impersonating it', () => {
    const source = event({
      author: { uid: 'local-profile-placeholder', name: 'Original display name', role: 'dad' },
    })
    const before = structuredClone(source)
    const derived = deriveUploadReadyEvent(source, WRITER_UID)

    expect(source).toEqual(before)
    expect(derived).not.toBe(source)
    expect(derived.author).toEqual({
      uid: WRITER_UID,
      name: 'Original display name',
      role: 'dad',
    })
    expect(derived.at).toBe(source.at)
    expect(derived.data).toEqual(source.data)
    expect(derived.createdAt).toBe(source.createdAt)
    expect(derived.updatedAt).toBe(source.updatedAt)
    expect(eventMigrationSourceContentId(derived)).toBe(getEventContentId(source))
    expect(isUploadReadyEvent(derived, WRITER_UID)).toBe(true)
    expect(parseCloudEventPayload(makeCloudEventDocId(derived), { event: derived }, NOW)?.event).toEqual(derived)
  })

  it('migrates missing-mutationId legacy records losslessly and reads old legacy documents', () => {
    const legacy = event({ mutationId: undefined })
    const derived = deriveUploadReadyEvent(legacy, WRITER_UID)

    expect(derived.mutationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(legacy.mutationId).toBeUndefined()
    expect(eventMigrationSourceContentId(derived)).toBe(getEventContentId(legacy))

    expect(parseCloudEventPayload('event-1_1', { event: legacy }, NOW)?.event).toEqual(legacy)

    const poisonedLegacy = { ...legacy, rev: NOW + CLOUD_FUTURE_SKEW_MS + 1 }
    expect(parseCloudEventPayload(
      `event-1_${poisonedLegacy.rev}`,
      { event: poisonedLegacy },
      NOW,
    )).toBeNull()
  })

  it('rejects timestamp-shadow tampering, far-future writes, and invalid typed data', () => {
    const native = event()
    const ready = { ...native, sync: createEventSyncMetadata(native) }
    const docId = makeCloudEventDocId(ready)
    expect(parseCloudEventPayload(docId, { event: {
      ...ready,
      sync: { ...ready.sync, updatedAtMs: ready.sync.updatedAtMs + 1 },
    } }, NOW)).toBeNull()

    const future = event({
      at: new Date(NOW + CLOUD_FUTURE_SKEW_MS + 1).toISOString(),
      createdAt: new Date(NOW + CLOUD_FUTURE_SKEW_MS + 1).toISOString(),
      updatedAt: new Date(NOW + CLOUD_FUTURE_SKEW_MS + 1).toISOString(),
    })
    const futureReady = { ...future, sync: createEventSyncMetadata(future) }
    expect(parseCloudEventPayload(makeCloudEventDocId(futureReady), { event: futureReady }, NOW)).toBeNull()

    expect(() => deriveUploadReadyEvent(event({
      data: { celsius: Number.POSITIVE_INFINITY },
    }), WRITER_UID)).toThrow(/celsius|data/i)
  })
})
