import { describe, expect, it } from 'vitest'
import type { DiaryEvent } from '../shared/types'

type ResolverModule = {
  compareEventMutations?: (left: DiaryEvent, right: DiaryEvent) => number
  ensureEventMutationIdentity?: (event: DiaryEvent) => DiaryEvent
  getEventStorageKey?: (event: DiaryEvent) => string
  getEventMutationKey?: (event: DiaryEvent) => string
  resolveLatestEvent?: (events: readonly DiaryEvent[]) => DiaryEvent | undefined
  validateDiaryEvent?: (event: unknown) => string | null
}

async function loadResolver(): Promise<ResolverModule> {
  const modulePath = '../shared/eventResolver'
  try {
    return await import(/* @vite-ignore */ modulePath) as ResolverModule
  } catch {
    return {}
  }
}

function makeEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  const now = '2026-07-13T08:00:00.000Z'
  return {
    id: 'shared-event',
    mutationId: '11111111-1111-4111-8111-111111111111',
    type: 'pee',
    at: now,
    data: {},
    author: { uid: 'parent', name: 'Parent', role: 'mom' },
    createdAt: now,
    updatedAt: now,
    rev: 2,
    deleted: false,
    ...overrides,
  }
}

describe('shared event mutation resolver', () => {
  it('exposes one shared comparator, identity key, and resolver', async () => {
    const resolver = await loadResolver()
    expect(typeof resolver.compareEventMutations).toBe('function')
    expect(typeof resolver.getEventMutationKey).toBe('function')
    expect(typeof resolver.resolveLatestEvent).toBe('function')
  })

  it('uses higher revision before every same-revision tie-break', async () => {
    const { compareEventMutations } = await loadResolver()
    expect(compareEventMutations).toBeTypeOf('function')
    const higher = makeEvent({ rev: 3, updatedAt: '2026-07-13T07:00:00.000Z' })
    const lowerTombstone = makeEvent({
      mutationId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      rev: 2,
      deleted: true,
      updatedAt: '2026-07-13T09:00:00.000Z',
    })
    expect(compareEventMutations!(higher, lowerTombstone)).toBeGreaterThan(0)
  })

  it('uses tombstone safety before updatedAt at the same revision', async () => {
    const { compareEventMutations } = await loadResolver()
    const live = makeEvent({
      mutationId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      updatedAt: '2026-07-13T10:00:00.000Z',
    })
    const tombstone = makeEvent({
      mutationId: '11111111-1111-4111-8111-111111111111',
      deleted: true,
      updatedAt: '2026-07-13T06:00:00.000Z',
    })
    expect(compareEventMutations!(tombstone, live)).toBeGreaterThan(0)
  })

  it('uses updatedAt then immutable mutation identity for a total order', async () => {
    const { compareEventMutations, resolveLatestEvent } = await loadResolver()
    const lowerIdentity = makeEvent({
      mutationId: '11111111-1111-4111-8111-111111111111',
      at: '2026-07-13T07:00:00.000Z',
    })
    const higherIdentity = makeEvent({
      mutationId: '22222222-2222-4222-8222-222222222222',
      at: '2026-07-13T09:00:00.000Z',
    })

    expect(compareEventMutations!(higherIdentity, lowerIdentity)).toBeGreaterThan(0)
    expect(resolveLatestEvent!([lowerIdentity, higherIdentity])).toEqual(higherIdentity)
    expect(resolveLatestEvent!([higherIdentity, lowerIdentity])).toEqual(higherIdentity)
  })

  it('keeps legacy mutation-less records deterministic and compatible', async () => {
    const { getEventMutationKey, resolveLatestEvent } = await loadResolver()
    const older = makeEvent({ mutationId: undefined, updatedAt: '2026-07-13T08:00:00.000Z' })
    const newer = makeEvent({
      mutationId: undefined,
      updatedAt: '2026-07-13T08:00:01.000Z',
      data: { note: 'legacy edit' },
    })

    expect(getEventMutationKey!(older)).toContain('legacy')
    expect(resolveLatestEvent!([newer, older])).toEqual(newer)
    expect(resolveLatestEvent!([older, newer])).toEqual(newer)
  })

  it('projects legacy variants to stable distinct sync identities without rewriting the input', async () => {
    const { ensureEventMutationIdentity } = await loadResolver()
    expect(ensureEventMutationIdentity).toBeTypeOf('function')
    const first = makeEvent({ mutationId: undefined, data: { amount: 1, note: 'legacy' } })
    const sameCanonical = makeEvent({ mutationId: undefined, data: { note: 'legacy', amount: 1 } })
    const concurrent = makeEvent({ mutationId: undefined, data: { amount: 2, note: 'legacy' } })

    const projected = ensureEventMutationIdentity!(first)
    expect(projected).not.toBe(first)
    expect(first.mutationId).toBeUndefined()
    expect(projected.mutationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(ensureEventMutationIdentity!(sameCanonical).mutationId).toBe(projected.mutationId)
    expect(ensureEventMutationIdentity!(concurrent).mutationId).not.toBe(projected.mutationId)
  })

  it('does not let a reused mutation UUID hide a different event or revision', async () => {
    const { getEventMutationKey } = await loadResolver()
    const first = makeEvent({ id: 'event-a', rev: 1 })
    const reused = makeEvent({ id: 'event-b', rev: 9 })
    expect(getEventMutationKey!(first)).not.toBe(getEventMutationKey!(reused))
  })

  it('preserves different payloads even when a corrupt producer reuses one mutation UUID', async () => {
    const { getEventStorageKey, resolveLatestEvent } = await loadResolver()
    expect(getEventStorageKey).toBeTypeOf('function')
    const first = makeEvent({ data: { note: 'first payload' } })
    const second = makeEvent({ data: { note: 'second payload' } })

    expect(getEventStorageKey!(first)).not.toBe(getEventStorageKey!(second))
    expect(resolveLatestEvent!([first, second])).toEqual(resolveLatestEvent!([second, first]))
  })

  it('rejects OS-dependent timestamps, unsafe revisions, oversized ids, and non-JSON extensions', async () => {
    const { validateDiaryEvent } = await loadResolver()
    expect(validateDiaryEvent).toBeTypeOf('function')
    expect(validateDiaryEvent!(makeEvent({ updatedAt: '2026-07-13T08:00:00' }))).toMatch(/updatedAt/)
    expect(validateDiaryEvent!(makeEvent({ rev: Number.MAX_SAFE_INTEGER + 1 }))).toMatch(/rev/)
    expect(validateDiaryEvent!(makeEvent({ id: '가'.repeat(200) }))).toMatch(/id/)

    const cyclic = makeEvent() as DiaryEvent & { extension?: unknown }
    cyclic.extension = cyclic
    expect(validateDiaryEvent!(cyclic)).toMatch(/JSON/)
    const nonJson = makeEvent({ data: { capturedAt: new Date() } as never })
    expect(validateDiaryEvent!(nonJson)).toMatch(/JSON/)
  })

  it('keeps a total order even when an untrusted timestamp is invalid', async () => {
    const { compareEventMutations, resolveLatestEvent } = await loadResolver()
    const first = makeEvent({
      mutationId: '11111111-1111-4111-8111-111111111111',
      updatedAt: 'invalid-a',
    })
    const second = makeEvent({
      mutationId: '22222222-2222-4222-8222-222222222222',
      updatedAt: 'invalid-b',
    })

    const forward = compareEventMutations!(first, second)
    const reverse = compareEventMutations!(second, first)
    expect(forward).toBe(-reverse)
    expect(forward).not.toBe(0)
    expect(resolveLatestEvent!([first, second])).toEqual(resolveLatestEvent!([second, first]))
  })
})
