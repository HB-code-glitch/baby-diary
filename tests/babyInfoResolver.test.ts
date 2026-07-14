import { describe, expect, it } from 'vitest'
import type { BabyInfoMutation } from '../shared/types'
import {
  babyInfoBoundarySourceMutationKey,
  canonicalBabyInfoMutationJson,
  compareBabyInfoMutations,
  deriveUploadReadyBabyInfoMutation,
  getBabyInfoMutationKey,
  isBabyInfoMutationUploadReady,
  makeAuthBoundLegacyCloudBridgeBabyInfoMutation,
  makeLegacyCloudBabyInfoMutation,
  makeLegacyCloudBridgeBabyInfoMutation,
  makeLegacyLocalBabyInfoMutation,
  normalizeBabyInfoSyncState,
  resolveLatestBabyInfoMutation,
  validateBabyInfoMutationForCloud,
} from '../shared/babyInfoResolver'

const FAMILY_ID = 'family-1'

function mutation(overrides: Partial<BabyInfoMutation> = {}): BabyInfoMutation {
  return {
    mutationId: '00000000-0000-4000-8000-000000000001',
    familyId: FAMILY_ID,
    babyName: '하루',
    babyBirthdate: '2026-01-02',
    logicalClock: 1,
    updatedAt: '2026-07-13T01:02:03.000Z',
    authorId: 'user-1',
    origin: 'user',
    ...overrides,
  }
}

describe('baby info mutation resolver', () => {
  it('durably identifies an auth-bound timestamp-shadow derivative for an old pending source', () => {
    const now = Date.parse('2026-07-13T12:00:00.000Z')
    const source = mutation({ updatedAtMs: undefined, authorId: 'old-local-profile' })
    const before = structuredClone(source)
    const derived = deriveUploadReadyBabyInfoMutation(source, 'firebase-user', now)

    expect(source).toEqual(before)
    expect(derived).toMatchObject({
      familyId: source.familyId,
      babyName: source.babyName,
      babyBirthdate: source.babyBirthdate,
      logicalClock: now,
      updatedAt: new Date(now).toISOString(),
      updatedAtMs: now,
      authorId: 'firebase-user',
      origin: 'user',
    })
    expect(babyInfoBoundarySourceMutationKey(derived)).toBe(getBabyInfoMutationKey(source))
    expect(isBabyInfoMutationUploadReady(derived, 'firebase-user', now)).toBe(true)
    expect(() => deriveUploadReadyBabyInfoMutation(derived, 'another-user', now + 1)).toThrow(/rebound/)
  })

  it('requires an exact timestamp shadow and rejects future/clock poison at the cloud boundary', () => {
    const now = Date.parse('2026-07-13T12:00:00.000Z')
    const valid = mutation({
      updatedAt: '2026-07-13T10:00:00.000Z',
      updatedAtMs: Date.parse('2026-07-13T10:00:00.000Z'),
    })
    expect(validateBabyInfoMutationForCloud(valid, now)).toBe(true)
    expect(validateBabyInfoMutationForCloud({ ...valid, updatedAtMs: valid.updatedAtMs! + 1 }, now)).toBe(false)
    expect(validateBabyInfoMutationForCloud({
      ...valid,
      logicalClock: now + 300_001,
    }, now)).toBe(false)
    expect(validateBabyInfoMutationForCloud({
      ...valid,
      updatedAt: '2026-07-13T12:05:00.001Z',
      updatedAtMs: now + 300_001,
    }, now)).toBe(false)
  })

  it('rejects forbidden and UTF-8 oversized family document segments', () => {
    const base = mutation({ familyId: 'family-safe' })
    expect(() => canonicalBabyInfoMutationJson({ ...base, familyId: '.' })).toThrow()
    expect(() => canonicalBabyInfoMutationJson({ ...base, familyId: '..' })).toThrow()
    expect(() => canonicalBabyInfoMutationJson({ ...base, familyId: '가'.repeat(501) })).toThrow()
    expect(() => canonicalBabyInfoMutationJson({ ...base, familyId: '가'.repeat(500) })).not.toThrow()
  })

  it('creates a deterministic legacy-cloud bridge bound to the prior winner key', () => {
    const prior = mutation({ babyName: 'Prior', logicalClock: 8 })
    const priorKey = getBabyInfoMutationKey(prior)
    const first = makeLegacyCloudBridgeBabyInfoMutation(
      FAMILY_ID,
      'Old client edit',
      '2026-06-06',
      priorKey,
      prior,
    )
    const second = makeLegacyCloudBridgeBabyInfoMutation(
      FAMILY_ID,
      'Old client edit',
      '2026-06-06',
      priorKey,
      { ...prior },
    )

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      familyId: FAMILY_ID,
      babyName: 'Old client edit',
      babyBirthdate: '2026-06-06',
      logicalClock: 9,
      origin: 'legacy-cloud',
    })
    expect(compareBabyInfoMutations(first!, prior)).toBeGreaterThan(0)
    expect(makeLegacyCloudBridgeBabyInfoMutation(
      FAMILY_ID,
      prior.babyName,
      prior.babyBirthdate,
      priorKey,
      prior,
    )).toBeUndefined()
    expect(() => makeLegacyCloudBridgeBabyInfoMutation(
      FAMILY_ID,
      'Old client edit',
      '2026-06-06',
      getBabyInfoMutationKey(mutation({ mutationId: '00000000-0000-4000-8000-000000000002' })),
      prior,
    )).toThrow(/marker key mismatch/i)
  })

  it('creates an auth-bound HLC bridge for a v0.3.8 pair-only update', () => {
    const now = Date.parse('2026-07-13T12:00:00.000Z')
    const prior = mutation({ babyName: 'Prior', logicalClock: 8 })
    const priorKey = getBabyInfoMutationKey(prior)
    const bridge = makeAuthBoundLegacyCloudBridgeBabyInfoMutation(
      FAMILY_ID,
      'Old client edit',
      '2026-06-06',
      priorKey,
      prior,
      'firebase-user',
      now,
    )

    expect(bridge).toMatchObject({
      logicalClock: now,
      updatedAt: new Date(now).toISOString(),
      updatedAtMs: now,
      authorId: 'firebase-user',
      origin: 'user',
      migration: {
        version: 1,
        kind: 'legacy-pair-bridge-v1',
        sourceMutationKey: priorKey,
      },
    })
    expect(isBabyInfoMutationUploadReady(bridge!, 'firebase-user', now)).toBe(true)
  })
  it('treats a missing state as the empty versioned state', () => {
    expect(normalizeBabyInfoSyncState(undefined)).toEqual({
      version: 1,
      mutations: [],
      pendingMutationKeys: [],
    })
  })

  it.each([
    null,
    {},
    { version: 2, mutations: [], pendingMutationKeys: [] },
    { version: 1, mutations: {}, pendingMutationKeys: [] },
    { version: 1, mutations: [], pendingMutationKeys: 'not-an-array' },
    { version: 1, mutations: [mutation({ logicalClock: Number.MAX_SAFE_INTEGER + 1 })], pendingMutationKeys: [] },
    { version: 1, mutations: [mutation({ updatedAt: '2026-07-13T01:02:03' })], pendingMutationKeys: [] },
    { version: 1, mutations: [mutation({ origin: 'legacy-local', logicalClock: 1 })], pendingMutationKeys: [] },
    { version: 1, mutations: [mutation()], pendingMutationKeys: ['unknown-key'] },
  ])('rejects malformed explicit state without discarding it: %j', malformed => {
    expect(() => normalizeBabyInfoSyncState(malformed)).toThrow(/baby info sync/i)
  })

  it('deduplicates only exact duplicate mutations and pending keys', () => {
    const value = mutation()
    const key = getBabyInfoMutationKey(value)

    expect(normalizeBabyInfoSyncState({
      version: 1,
      mutations: [value, { ...value }],
      pendingMutationKeys: [key, key],
    })).toEqual({
      version: 1,
      mutations: [value],
      pendingMutationKeys: [key],
    })
  })

  it('preserves reused mutation UUIDs when their immutable payload differs', () => {
    const first = mutation({ babyName: '첫 payload' })
    const second = mutation({ babyName: '둘째 payload' })

    expect(getBabyInfoMutationKey(first)).not.toBe(getBabyInfoMutationKey(second))
    expect(normalizeBabyInfoSyncState({
      version: 1,
      mutations: [first, second],
      pendingMutationKeys: [],
    }).mutations).toHaveLength(2)
  })

  it('uses logical clock before timestamp when resolving older and newer edits', () => {
    const olderClock = mutation({
      mutationId: '00000000-0000-4000-8000-000000000002',
      logicalClock: 1,
      updatedAt: '2026-07-13T10:00:00.000Z',
      babyName: 'clock 1',
    })
    const newerClock = mutation({
      mutationId: '00000000-0000-4000-8000-000000000003',
      logicalClock: 2,
      updatedAt: '2026-07-12T10:00:00.000Z',
      babyName: 'clock 2',
    })

    expect(resolveLatestBabyInfoMutation([olderClock, newerClock])).toEqual(newerClock)
  })

  it('breaks a same-clock same-timestamp tie deterministically regardless of arrival order', () => {
    const first = mutation({
      mutationId: '00000000-0000-4000-8000-000000000004',
      babyName: '가',
    })
    const second = mutation({
      mutationId: '00000000-0000-4000-8000-000000000005',
      babyName: '나',
    })

    expect(compareBabyInfoMutations(first, second)).not.toBe(0)
    expect(resolveLatestBabyInfoMutation([first, second])).toEqual(
      resolveLatestBabyInfoMutation([second, first]),
    )
  })

  it('accepts intentional blank values in a user mutation', () => {
    const cleared = mutation({ babyName: '', babyBirthdate: '' })
    const normalized = normalizeBabyInfoSyncState({
      version: 1,
      mutations: [cleared],
      pendingMutationKeys: [getBabyInfoMutationKey(cleared)],
    })

    expect(normalized.mutations[0].babyName).toBe('')
    expect(normalized.mutations[0].babyBirthdate).toBe('')
  })

  it('projects legacy local and cloud values to stable distinct mutations', () => {
    const local1 = makeLegacyLocalBabyInfoMutation(FAMILY_ID, '로컬', '2026-01-01')
    const local2 = makeLegacyLocalBabyInfoMutation(FAMILY_ID, '로컬', '2026-01-01')
    const cloud = makeLegacyCloudBabyInfoMutation(FAMILY_ID, '클라우드', '2025-12-31')

    expect(local1).toEqual(local2)
    expect(local1?.logicalClock).toBe(0)
    expect(local1?.origin).toBe('legacy-local')
    expect(cloud?.origin).toBe('legacy-cloud')
    expect(getBabyInfoMutationKey(local1!)).not.toBe(getBabyInfoMutationKey(cloud!))
    expect(makeLegacyLocalBabyInfoMutation(FAMILY_ID, '', '')).toBeUndefined()
  })

  it('prefers legacy local over legacy cloud, while any new user clock wins both', () => {
    const local = makeLegacyLocalBabyInfoMutation(FAMILY_ID, '로컬', '2026-01-01')!
    const cloud = makeLegacyCloudBabyInfoMutation(FAMILY_ID, '클라우드', '2025-12-31')!
    const user = mutation({
      babyName: '',
      babyBirthdate: '',
      updatedAt: '1970-01-01T00:00:00.000Z',
    })

    expect(resolveLatestBabyInfoMutation([cloud, local])).toEqual(local)
    expect(resolveLatestBabyInfoMutation([user, cloud, local])).toEqual(user)
  })

  it('canonicalizes equivalent objects independently of insertion order', () => {
    const value = mutation()
    const reordered = {
      origin: value.origin,
      authorId: value.authorId,
      updatedAt: value.updatedAt,
      logicalClock: value.logicalClock,
      babyBirthdate: value.babyBirthdate,
      babyName: value.babyName,
      familyId: value.familyId,
      mutationId: value.mutationId,
    } as BabyInfoMutation

    expect(canonicalBabyInfoMutationJson(value)).toBe(canonicalBabyInfoMutationJson(reordered))
    expect(getBabyInfoMutationKey(value)).toBe(getBabyInfoMutationKey(reordered))
  })
})
