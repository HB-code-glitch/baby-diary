import { describe, expect, it } from 'vitest'
import type { DiaryEvent } from '../shared/types'
import {
  CLOUD_FUTURE_SKEW_MS,
  cloudEventPayloadEquals,
  createEventSyncMetadata,
  deriveUploadReadyEvent,
  eventMigrationSourceContentId,
  isUploadReadyEvent,
  makeCloudEventDocId,
  parseCloudEventPayload,
} from '../shared/cloudEventPayload'
import {
  compareEventMutations,
  deriveAuthBoundEvent,
  getEventContentId,
  isExactAuthBoundDerivative,
  resolveLatestEvent,
} from '../shared/eventResolver'

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
  it('treats native writes as sources and only their canonical projection as upload-ready', () => {
    const source = event()
    const native = { ...source, sync: createEventSyncMetadata(source) }
    const ready = deriveUploadReadyEvent(native, WRITER_UID)

    expect(isUploadReadyEvent(native, WRITER_UID)).toBe(false)
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
    expect(ready.rev).toBe(Date.parse(source.updatedAt))
    expect(ready.mutationId).toBe(source.mutationId)

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

  it('always resolves an exact auth-bound derivative over its retained source', () => {
    const source = event({
      mutationId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      author: { uid: 'other-account', name: 'Original display name', role: 'dad' },
      sync: createEventSyncMetadata(event()),
    })
    source.sync = createEventSyncMetadata(source)
    const derivative = deriveUploadReadyEvent(source, WRITER_UID)

    expect(derivative).toEqual(deriveAuthBoundEvent(source, WRITER_UID))
    expect(isExactAuthBoundDerivative(derivative, source)).toBe(true)
    expect(isExactAuthBoundDerivative({ ...derivative, rev: source.rev }, source)).toBe(false)
    expect(isExactAuthBoundDerivative({ ...derivative, data: { celsius: 39.9 } }, source)).toBe(false)
    expect(resolveLatestEvent([source, derivative])).toEqual(derivative)
    expect(resolveLatestEvent([derivative, source])).toEqual(derivative)
  })

  it('never gives forged migration claims privileged resolver priority', () => {
    const source = event({
      mutationId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      author: { uid: 'other-account', name: 'Original display name', role: 'dad' },
    })
    const exact = deriveUploadReadyEvent(source, WRITER_UID)
    const forgeries: DiaryEvent[] = [
      { ...exact, rev: source.rev, mutationId: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee' },
      { ...exact, rev: source.rev, data: { celsius: 39.9 } },
      { ...exact, rev: source.rev, author: { ...exact.author, name: 'Forged name' } },
      { ...exact, rev: source.rev, author: { ...exact.author, role: 'mom' } },
      { ...exact, rev: source.rev, sync: { ...exact.sync!, updatedAtMs: exact.sync!.updatedAtMs + 1 } },
    ]

    const migratedSource: DiaryEvent = {
      ...source,
      migration: {
        version: 1,
        kind: 'legacy-author-v1',
        sourceContentId: getEventContentId(source),
      },
    }
    forgeries.push({
      ...exact,
      rev: migratedSource.rev,
      migration: {
        version: 1,
        kind: 'legacy-author-v1',
        sourceContentId: getEventContentId(migratedSource),
      },
    })

    for (const forged of forgeries.slice(0, -1)) {
      expect(forged.migration?.sourceContentId).toBe(getEventContentId(source))
      const ordinaryWinner = compareEventMutations(forged, source) > 0 ? forged : source
      expect(resolveLatestEvent([source, forged])).toEqual(ordinaryWinner)
      expect(resolveLatestEvent([forged, source])).toEqual(ordinaryWinner)
    }
    const reboundForgery = forgeries.at(-1)!
    expect(reboundForgery.migration?.sourceContentId).toBe(getEventContentId(migratedSource))
    const reboundWinner = compareEventMutations(reboundForgery, migratedSource) > 0
      ? reboundForgery
      : migratedSource
    expect(resolveLatestEvent([migratedSource, reboundForgery])).toEqual(reboundWinner)
    expect(resolveLatestEvent([reboundForgery, migratedSource])).toEqual(reboundWinner)
  })

  it('keeps revision and tombstone safety ahead of identity tie-breaks', () => {
    const source = event({
      mutationId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      author: { uid: 'other-account', name: 'Original display name', role: 'dad' },
    })
    const derivative = deriveUploadReadyEvent(source, WRITER_UID)
    const higherRevisionSource = { ...source, rev: derivative.rev + 1 }

    expect(resolveLatestEvent([higherRevisionSource, derivative])).toEqual(higherRevisionSource)
    expect(resolveLatestEvent([derivative, higherRevisionSource])).toEqual(higherRevisionSource)

    const tombstoneSource = { ...source, deleted: true }
    const forgedLiveDerivative = {
      ...deriveUploadReadyEvent(tombstoneSource, WRITER_UID),
      rev: tombstoneSource.rev,
      deleted: false,
    }
    expect(getEventContentId(tombstoneSource)).toBe(forgedLiveDerivative.migration?.sourceContentId)
    expect(resolveLatestEvent([tombstoneSource, forgedLiveDerivative])).toEqual(tombstoneSource)
    expect(resolveLatestEvent([forgedLiveDerivative, tombstoneSource])).toEqual(tombstoneSource)
  })

  it('keeps a deterministic total order for unrelated same-revision mutations', () => {
    const left = event({ mutationId: '11111111-1111-4111-8111-111111111111' })
    const right = event({ mutationId: 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee' })
    const forward = resolveLatestEvent([left, right])

    expect(resolveLatestEvent([right, left])).toEqual(forward)
    expect([left, right]).toContainEqual(forward)
  })

  it('preserves the source conflict winner after every source is canonically projected', () => {
    const lowerSource = event({ mutationId: '11111111-1111-4111-8111-111111111111' })
    const higherSource = event({ mutationId: 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee' })
    const lowerCanonical = deriveUploadReadyEvent(lowerSource, WRITER_UID)
    const higherCanonical = deriveUploadReadyEvent(higherSource, WRITER_UID)

    expect(resolveLatestEvent([lowerSource, higherSource])).toEqual(higherSource)
    expect(lowerCanonical.rev).toBe(higherCanonical.rev)
    expect(lowerCanonical.mutationId).toBe(lowerSource.mutationId)
    expect(higherCanonical.mutationId).toBe(higherSource.mutationId)
    expect(resolveLatestEvent([lowerCanonical, higherCanonical])).toEqual(higherCanonical)
  })

  it('lets a preserved source deterministically supersede a legacy same-revision derivative', () => {
    const source = event({ author: { uid: 'legacy-owner', name: 'Parent', role: 'mom' } })
    const canonical = deriveUploadReadyEvent(source, WRITER_UID)
    const legacySameRevision = { ...canonical, rev: source.rev }

    expect(isUploadReadyEvent(legacySameRevision, WRITER_UID)).toBe(true)
    expect(resolveLatestEvent([source, legacySameRevision, canonical])).toEqual(canonical)
    expect(canonical.rev).toBeGreaterThan(legacySameRevision.rev)
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

  it('refuses to rebind an already-migrated derivative onto a second writer uid', () => {
    const source = event({
      author: { uid: 'local-profile-placeholder', name: 'Original display name', role: 'dad' },
    })
    const derived = deriveUploadReadyEvent(source, WRITER_UID)

    // Idempotent for the same writer uid: no rebinding needed, no throw.
    expect(deriveUploadReadyEvent(derived, WRITER_UID)).toBe(derived)

    // A derivative already carries its own migration provenance; deriving it again
    // for a *different* writer uid would silently chain a derivative-of-derivative
    // (a distinct content id, and thus a distinct cloud document) instead of the
    // untouched original re-deriving the correct one. Fail closed instead.
    expect(() => deriveUploadReadyEvent(derived, 'another-writer-uid')).toThrow(/rebound/)
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

  describe('cloudEventPayloadEquals — exact server read-back ACK', () => {
    it('accepts only an exact document-id and canonical-payload match', () => {
      const source = event({
        author: { uid: 'local-profile-placeholder', name: 'Original display name', role: 'dad' },
      })
      const derivative = deriveUploadReadyEvent(source, WRITER_UID)
      const docId = makeCloudEventDocId(derivative)
      const readBack = parseCloudEventPayload(docId, { event: derivative }, NOW)

      expect(readBack).not.toBeNull()
      expect(cloudEventPayloadEquals(readBack!, derivative)).toBe(true)
    })

    it('rejects a read-back whose canonical payload differs even when the doc id matches', () => {
      const source = event()
      const derivative = deriveUploadReadyEvent(source, WRITER_UID)
      const docId = makeCloudEventDocId(derivative)

      // A malformed/tampered sibling written at the exact same content-bound id
      // with different bytes must never be treated as an ACK for `derivative`.
      const tampered: DiaryEvent = { ...derivative, data: { celsius: 39.9 } }
      const readBack = parseCloudEventPayload(docId, { event: tampered }, NOW)

      // parseCloudEventPayload itself rejects this (identity no longer matches the
      // content-bound doc id), which is exactly the fail-closed behavior required —
      // an already-exists-different-bytes sibling can never be parsed as this ACK.
      expect(readBack).toBeNull()
    })

    it('the equality check itself rejects matching doc id with differing canonical bytes', () => {
      // Construct a parsed payload directly (bypassing parseCloudEventPayload's own
      // identity filter) to prove cloudEventPayloadEquals independently enforces
      // byte-for-byte canonical equality, not just doc-id equality.
      const source = event()
      const derivative = deriveUploadReadyEvent(source, WRITER_UID)
      const docId = makeCloudEventDocId(derivative)
      const sameIdDifferentBytes = { ...derivative, data: { celsius: 40.1 } }

      expect(cloudEventPayloadEquals({ event: sameIdDifferentBytes, docId }, derivative)).toBe(false)
    })

    it('rejects a read-back for a different (but validly parsed) event at another id', () => {
      const source = event()
      const derivative = deriveUploadReadyEvent(source, WRITER_UID)
      const otherSource = event({ id: 'event-2' })
      const otherDerivative = deriveUploadReadyEvent(otherSource, WRITER_UID)
      const otherDocId = makeCloudEventDocId(otherDerivative)
      const readBack = parseCloudEventPayload(otherDocId, { event: otherDerivative }, NOW)

      expect(readBack).not.toBeNull()
      expect(cloudEventPayloadEquals(readBack!, derivative)).toBe(false)
    })

    it('is reflexive for an already upload-ready native write (no derivation needed)', () => {
      const native = event()
      const ready = { ...native, sync: createEventSyncMetadata(native) }
      const docId = makeCloudEventDocId(ready)
      const readBack = parseCloudEventPayload(docId, { event: ready }, NOW)

      expect(readBack).not.toBeNull()
      expect(cloudEventPayloadEquals(readBack!, ready)).toBe(true)
    })
  })
})
