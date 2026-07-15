import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, DiaryEvent } from '../shared/types'
import {
  createEventSyncMetadata,
  deriveUploadReadyEvent,
  makeCloudEventDocId,
} from '../shared/cloudEventPayload'
import { getEventStorageKey } from '../shared/eventResolver'
import * as upgradeContract from '../scripts/upgrade-data-contract.mjs'

type FakeDoc = {
  id: string
  path: string
  data: () => unknown
  exists: () => boolean
}

const harness = vi.hoisted(() => ({
  auth: { currentUser: { uid: 'user-1', email: 'parent@example.test' } },
  db: { name: 'db' },
  localMutations: [] as DiaryEvent[],
  localEvents: [] as DiaryEvent[],
  appended: [] as DiaryEvent[],
  remote: new Map<string, DiaryEvent>(),
  babyRemote: new Map<string, Record<string, unknown>>(),
  settings: {
    baby: { name: 'Sync Baby', birthdate: '2026-01-15' },
    profile: { uid: 'user-1', name: 'Parent', role: 'mom' as const },
    familyId: 'family-1',
    firebase: null,
  } as AppSettings,
  snapshot: null as null | ((snapshot: { docChanges: () => unknown[] }) => void),
  blockWrites: false,
}))

vi.mock('../src/sync/firebase', () => ({
  preflightFirebasePersistence: vi.fn(async () => ({
    version: 1,
    configIdentity: 'test-config',
    appName: 'baby-diary-test',
  })),
  initFirebase: vi.fn(async () => ({ auth: harness.auth, db: harness.db })),
  teardownFirebase: vi.fn(async () => undefined),
  fbSignIn: vi.fn(),
  fbSignUp: vi.fn(),
  fbSignOut: vi.fn(),
  getFirebaseAuth: vi.fn(() => harness.auth),
}))

vi.mock('../src/lib/ipc', () => ({
  ipc: {
    getFirebaseEmulator: vi.fn(async () => null),
    listEvents: vi.fn(async () => [...harness.localEvents]),
    listEventMutations: vi.fn(async (expectedFamilyId?: string) => {
      if (expectedFamilyId !== undefined && expectedFamilyId !== harness.settings.familyId) {
        throw new Error('EVENT_FAMILY_MISMATCH')
      }
      return [...harness.localMutations]
    }),
    appendEvent: vi.fn(async (event: DiaryEvent, expectedFamilyId?: string) => {
      if (expectedFamilyId !== undefined && expectedFamilyId !== harness.settings.familyId) return 'error'
      harness.appended.push(event)
      // Model the real EventLog: fsync-durable, content-addressed dedup — a
      // physical append (including an auth-bound upload derivative) is durably
      // discoverable by the very next listEventMutations() read-back.
      const key = getEventStorageKey(event)
      if (harness.localMutations.some(existing => getEventStorageKey(existing) === key)) return 'duplicate'
      harness.localMutations.push(event)
      return 'ok'
    }),
    confirmEventFamily: vi.fn(async (familyId: string) => (
      familyId === harness.settings.familyId
        ? { status: 'ok' as const, adoptionFamilyId: familyId, adoptedCount: harness.localMutations.length }
        : { status: 'error' as const, adoptedCount: 0 }
    )),
    getSettings: vi.fn(async () => structuredClone(harness.settings)),
    saveSettings: vi.fn(async (settings: AppSettings) => {
      const { applyManagedSettingsSave } = await import('../shared/babyInfoSettingsCommit')
      harness.settings = applyManagedSettingsSave(harness.settings, settings)
      return structuredClone(harness.settings)
    }),
    mergeSettings: vi.fn(async (partial: Partial<AppSettings>) => {
      const { applyManagedSettingsMerge } = await import('../shared/babyInfoSettingsCommit')
      harness.settings = applyManagedSettingsMerge(harness.settings, partial)
      return structuredClone(harness.settings)
    }),
    commitBabyInfo: vi.fn(async () => {
      throw new Error('baby-info subsystem is isolated in this event-collision suite')
    }),
    onEventAppended: vi.fn(() => () => undefined),
  },
}))

// This suite exercises immutable event collisions. Baby-info lifecycle and
// journal behavior have dedicated real-path suites, so isolate that subsystem.
vi.mock('../src/sync/babyInfoSync', () => ({
  makeBabyInfoDocId: vi.fn(() => 'baby-info'),
  parseCloudBabyInfoDocument: vi.fn(() => null),
  persistSettingsWithBabyInfoMutation: vi.fn(),
  reconcileFamilyBabyInfo: vi.fn(async () => ({
    pendingCount: 0,
    activePendingCount: 0,
    needsRetry: false,
    uploadFailures: 0,
    settings: structuredClone(harness.settings),
  })),
  setBabyInfoPersistenceObserver: vi.fn(),
}))

vi.mock('firebase/auth', async () => {
  const actual = await vi.importActual<typeof import('firebase/auth')>('firebase/auth')
  return {
    ...actual,
    onAuthStateChanged: vi.fn((_auth: unknown, callback: (user: unknown) => void) => {
      queueMicrotask(() => callback(harness.auth.currentUser))
      return () => undefined
    }),
  }
})

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore')

  const collection = vi.fn((...args: unknown[]) => {
    const path = args.slice(1).join('/')
    return { kind: 'collection', path }
  })

  const doc = vi.fn((...args: unknown[]) => {
    const [first, ...rest] = args
    const path = (first as { kind?: string; path?: string })?.kind === 'collection'
      ? `${(first as { path: string }).path}/${String(rest[0] ?? 'generated')}`
      : rest.join('/')
    return { kind: 'doc', path, id: path.split('/').at(-1) ?? '' }
  })

  const query = vi.fn((ref: unknown) => ref)
  const orderBy = vi.fn(() => ({}))
  const documentId = vi.fn(() => '__name__')
  const startAfter = vi.fn(() => ({}))
  const limit = vi.fn(() => ({}))

  const familyData = {
    name: 'Family',
    babyName: 'Sync Baby',
    babyBirthdate: '2026-01-15',
    members: { 'user-1': { name: 'Parent', role: 'mom' } },
    inviteCode: 'ABC234',
    createdAt: null,
  }

  const getDoc = vi.fn(async (ref: { path: string; id: string }) => {
    if (ref.path === 'users/user-1') {
      return { id: ref.id, exists: () => true, data: () => ({ familyId: 'family-1' }) }
    }
    if (ref.path === 'families/family-1') {
      return { id: ref.id, exists: () => true, data: () => familyData }
    }
    if (ref.path.includes('/babyInfoMutations/')) {
      const data = harness.babyRemote.get(ref.id)
      return { id: ref.id, exists: () => data !== undefined, data: () => data }
    }
    const event = harness.remote.get(ref.id)
    return { id: ref.id, exists: () => Boolean(event), data: () => ({ event }) }
  })

  const getDocs = vi.fn(async (ref: { path: string }) => ({
    docs: ref.path.endsWith('/babyInfoMutations')
      ? [...harness.babyRemote.entries()].map(([id, data]): FakeDoc => ({
          id,
          path: `families/family-1/babyInfoMutations/${id}`,
          exists: () => true,
          data: () => data,
        }))
      : [...harness.remote.entries()].map(([id, event]): FakeDoc => ({
      id,
      path: `families/family-1/events/${id}`,
      exists: () => true,
      data: () => ({ event }),
        })),
  }))

  const writeBatch = vi.fn(() => {
    const writes: Array<{ ref: { id: string }; event: DiaryEvent }> = []
    return {
      set: (ref: { id: string }, value: { event: DiaryEvent }) => {
        writes.push({ ref, event: value.event })
      },
      commit: async () => {
        if (harness.blockWrites) await new Promise<void>(() => undefined)
        if (writes.some(write => harness.remote.has(write.ref.id))) {
          throw Object.assign(new Error('already exists'), { code: 6 })
        }
        for (const write of writes) harness.remote.set(write.ref.id, write.event)
      },
    }
  })

  const onSnapshot = vi.fn((
    ref: { path?: string },
    _options: unknown,
    callback: (snapshot: { docChanges: () => unknown[] }) => void,
  ) => {
    if (ref.path?.endsWith('/events')) harness.snapshot = callback
    return () => undefined
  })

  return {
    ...actual,
    collection,
    doc,
    query,
    orderBy,
    documentId,
    startAfter,
    limit,
    getDoc,
    getDocs,
    setDoc: vi.fn(async (ref: { path: string; id: string }, data: Record<string, unknown>) => {
      if (ref.path.includes('/babyInfoMutations/')) harness.babyRemote.set(ref.id, data)
    }),
    updateDoc: vi.fn(async () => undefined),
    onSnapshot,
    writeBatch,
    serverTimestamp: vi.fn(() => null),
  }
})

const config = {
  apiKey: 'key',
  authDomain: 'example.test',
  projectId: 'demo-baby-diary',
  storageBucket: 'bucket',
  messagingSenderId: 'sender',
  appId: 'app',
}

function makeMutation(mutationId: string, overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  // A live, recent timestamp — parseCloudEventPayload's/deriveUploadReadyEvent's
  // server-side clock reasoning is anchored to the real wall clock, so a fixed/
  // hardcoded date is not safe here.
  const now = new Date(Date.now() - 60_000).toISOString()
  const base = {
    id: 'shared-event',
    mutationId,
    type: 'pee' as const,
    at: now,
    data: {},
    author: { uid: 'user-1', name: 'Parent', role: 'mom' as const },
    createdAt: now,
    updatedAt: now,
    rev: 2,
    deleted: false,
    ...overrides,
  }
  // Already auth-bound + synced for the connected uid ('user-1') by default, so
  // this suite's own already-upload-ready fixtures are uploaded as-is (matching
  // its pre-existing exact-mutationId assertions) instead of being migrated
  // through a fresh derivative. Tests that specifically exercise the legacy
  // migration path (e.g. `mutationId: undefined`) opt out via their own override.
  if (base.mutationId !== undefined && !('sync' in overrides)) {
    return { ...base, sync: createEventSyncMetadata(base) }
  }
  return base
}

async function connectEngine() {
  const engine = await import('../src/sync/syncEngine')
  await engine.configure(config, 'family-1')
  const online = new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined
    let settled = false
    const settle = (result: 'online' | 'error', detail: string) => {
      if (settled) return
      settled = true
      queueMicrotask(() => unsubscribe?.())
      if (result === 'online') resolve()
      else reject(new Error(`sync connection failed: ${detail}`))
    }
    unsubscribe = engine.subscribeStatus(state => {
      if (state.status === 'online') settle('online', state.detail)
      else if (state.status === 'error') settle('error', state.detail)
    })
  })
  await engine.start()
  await online
  expect(harness.snapshot).toBeTypeOf('function')
  return engine
}

describe('sync mutation collision integration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    localStorage.clear()
    harness.localMutations = []
    harness.localEvents = []
    harness.appended = []
    harness.remote.clear()
    harness.babyRemote.clear()
    harness.settings = {
      baby: { name: 'Sync Baby', birthdate: '2026-01-15' },
      profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
      familyId: 'family-1',
      firebase: null,
    }
    harness.snapshot = null
    harness.blockWrites = false
  })

  it('does not admit exact raw or auth-bound v0.3.8 fixture events into the pending queue', async () => {
    const raw = (upgradeContract.buildV038Fixture().events as DiaryEvent[])
      .find(item => item.id === 'legacy-temp')!
    const derivative = deriveUploadReadyEvent(raw, harness.auth.currentUser.uid)
    const engine = await import('../src/sync/syncEngine')

    engine.enqueue(raw, 'family-1')
    engine.enqueue(derivative, 'family-1')

    expect(JSON.parse(localStorage.getItem('babydiary.pendingUploads') ?? '[]')).toEqual([])
  })

  it('drops exact v0.3.8 fixture events from a persisted pending cache while retaining real work', async () => {
    const raw = (upgradeContract.buildV038Fixture().events as DiaryEvent[])
      .find(item => item.id === 'legacy-temp')!
    const derivative = deriveUploadReadyEvent(raw, harness.auth.currentUser.uid)
    const legitimate = makeMutation('99999999-9999-4999-8999-999999999999', { id: 'legitimate-pending' })
    localStorage.setItem('babydiary.pendingUploads', JSON.stringify([
      { event: raw, familyId: 'family-1', attempts: 0, nextRetry: 0 },
      { event: derivative, familyId: 'family-1', attempts: 0, nextRetry: 0 },
      { event: legitimate, familyId: 'family-1', attempts: 0, nextRetry: 0 },
    ]))

    const engine = await import('../src/sync/syncEngine')
    await engine.configure(config, 'family-1')

    expect(engine.getStatus().pendingCount).toBe(1)
    expect(JSON.parse(localStorage.getItem('babydiary.pendingUploads') ?? '[]'))
      .toEqual([{ event: legitimate, familyId: 'family-1', attempts: 0, nextRetry: 0 }])
    engine.stop()
  })

  it('does not upload exact local v0.3.8 fixture mutations during reconcile', async () => {
    harness.localMutations = upgradeContract.buildV038Fixture().events as DiaryEvent[]

    const engine = await connectEngine()

    expect(harness.remote.size).toBe(0)
    expect(harness.appended).toEqual([])
    engine.stop()
  })

  it('does not download exact raw or auth-bound v0.3.8 fixture mutations during reconcile', async () => {
    const raw = (upgradeContract.buildV038Fixture().events as DiaryEvent[])
      .find(item => item.id === 'legacy-formula' && item.rev === 2)!
    const derivative = deriveUploadReadyEvent(raw, harness.auth.currentUser.uid)
    harness.remote.set(makeCloudEventDocId(raw), raw)
    harness.remote.set(makeCloudEventDocId(derivative), derivative)

    const engine = await connectEngine()

    expect(harness.appended).toEqual([])
    engine.stop()
  })

  it('ignores exact raw and auth-bound v0.3.8 fixture snapshot changes while accepting real events', async () => {
    const raw = (upgradeContract.buildV038Fixture().events as DiaryEvent[])
      .find(item => item.id === 'legacy-temp')!
    const derivative = deriveUploadReadyEvent(raw, harness.auth.currentUser.uid)
    const legitimate = makeMutation('88888888-8888-4888-8888-888888888888', {
      id: 'legitimate-snapshot',
    })
    const engine = await connectEngine()

    harness.snapshot!({
      docChanges: () => [raw, derivative, legitimate].map(event => ({
        type: 'added',
        doc: { id: makeCloudEventDocId(event), data: () => ({ event }) },
      })),
    })
    await vi.waitFor(() => {
      expect(harness.appended.some(item => item.id === legitimate.id)).toBe(true)
    })

    expect(harness.appended).toEqual([legitimate])
    engine.stop()
  })

  it('persists both same-revision mutations in pending across a module restart', async () => {
    const first = makeMutation('11111111-1111-4111-8111-111111111111')
    const second = makeMutation('22222222-2222-4222-8222-222222222222', { data: { note: 'second' } })
    let engine = await import('../src/sync/syncEngine')

    engine.enqueue(first, 'family-1')
    engine.enqueue(second, 'family-1')
    engine.enqueue(first, 'family-1')

    let pending = JSON.parse(localStorage.getItem('babydiary.pendingUploads') ?? '[]')
    expect(pending.map((item: { event: DiaryEvent }) => item.event.mutationId)).toEqual([
      first.mutationId,
      second.mutationId,
    ])

    vi.resetModules()
    engine = await import('../src/sync/syncEngine')
    await engine.configure(config, 'family-1')
    expect(engine.getStatus().pendingCount).toBe(2)
    pending = JSON.parse(localStorage.getItem('babydiary.pendingUploads') ?? '[]')
    expect(pending).toHaveLength(2)
  })

  it('reconcile uploads every physical same-revision mutation, not only the resolved view', async () => {
    const first = makeMutation('11111111-1111-4111-8111-111111111111')
    const second = makeMutation('22222222-2222-4222-8222-222222222222', { data: { note: 'second' } })
    harness.localMutations = [second, first]
    harness.localEvents = [second]

    const engine = await connectEngine()

    expect(harness.remote.size).toBe(2)
    expect(new Set([...harness.remote.values()].map(event => event.mutationId))).toEqual(
      new Set([first.mutationId, second.mutationId]),
    )
    expect([...harness.remote.keys()].every(id => !id.includes('/'))).toBe(true)
    engine.stop()
  })

  it('migrates distinct legacy same-revision variants to distinct immutable cloud documents', async () => {
    const first = makeMutation('11111111-1111-4111-8111-111111111111', {
      mutationId: undefined,
      data: { note: 'first legacy edit' },
    })
    const second = makeMutation('22222222-2222-4222-8222-222222222222', {
      mutationId: undefined,
      data: { note: 'second legacy edit' },
    })
    harness.localMutations = [first, second]

    const engine = await connectEngine()

    expect(harness.remote.size).toBe(2)
    const uploaded = [...harness.remote.values()]
    expect(uploaded.every(event => event.mutationId !== undefined)).toBe(true)
    expect(new Set(uploaded.map(event => event.mutationId)).size).toBe(2)
    engine.stop()
  })

  it('preserves a reused mutation UUID as two stable cloud documents across reconnects', async () => {
    const first = makeMutation('11111111-1111-4111-8111-111111111111', { data: { note: 'first payload' } })
    const second = { ...first, data: { note: 'second payload' } }
    harness.localMutations = [first, second]

    let engine = await connectEngine()
    expect(harness.remote.size).toBe(2)
    const firstIds = [...harness.remote.keys()].sort()
    engine.stop()

    vi.resetModules()
    engine = await connectEngine()
    expect([...harness.remote.keys()].sort()).toEqual(firstIds)
    expect(engine.getStatus().pendingCount).toBe(0)
    engine.stop()
  })

  it('treats m2 as read compatibility and still migrates the exact payload to m3', async () => {
    const event = makeMutation('11111111-1111-4111-8111-111111111111')
    const m2DocId = `m2|${encodeURIComponent(event.id)}|${event.rev}|${event.mutationId}`
    harness.localMutations = [event]
    harness.remote.set(m2DocId, event)

    const engine = await connectEngine()
    const canonical = deriveUploadReadyEvent(event, harness.auth.currentUser.uid)

    expect(harness.remote.has(m2DocId)).toBe(true)
    expect(harness.remote.has(engine.makeDocId(canonical))).toBe(true)
    expect(harness.remote.size).toBe(2)
    engine.stop()
  })

  it.each(['raw-first', 'projection-first'] as const)(
    'preserves raw legacy source bytes when its identified projection shares the normalized key (%s)',
    async order => {
      const raw = makeMutation('11111111-1111-4111-8111-111111111111', {
        id: 'raw-legacy-source',
        mutationId: undefined,
        data: { note: 'raw provenance' },
      })
      const { ensureEventMutationIdentity } = await import('../shared/eventResolver')
      const identified = ensureEventMutationIdentity(raw)
      const expectedCanonical = deriveUploadReadyEvent(raw, harness.auth.currentUser.uid)
      const wrongProjectedCanonical = deriveUploadReadyEvent(identified, harness.auth.currentUser.uid)
      harness.localMutations = order === 'raw-first' ? [raw, identified] : [identified, raw]

      const engine = await connectEngine()

      expect(harness.remote.has(engine.makeDocId(expectedCanonical))).toBe(true)
      expect(harness.remote.has(engine.makeDocId(wrongProjectedCanonical))).toBe(false)
      expect(expectedCanonical.migration?.sourceContentId)
        .not.toBe(wrongProjectedCanonical.migration?.sourceContentId)
      engine.stop()
    },
  )

  it('does not re-project an exact foreign m2 source under the current account', async () => {
    const source = makeMutation('11111111-1111-4111-8111-111111111111', {
      author: { uid: 'other-member', name: 'Other', role: 'dad' },
    })
    const m2DocId = `m2|${encodeURIComponent(source.id)}|${source.rev}|${source.mutationId}`
    const forbiddenCanonical = deriveUploadReadyEvent(source, harness.auth.currentUser.uid)
    harness.localMutations = [source]
    harness.remote.set(m2DocId, source)

    const engine = await connectEngine()

    expect(harness.remote.has(m2DocId)).toBe(true)
    expect(harness.remote.has(engine.makeDocId(forbiddenCanonical))).toBe(false)
    expect(harness.remote.size).toBe(1)
    engine.stop()
  })

  it('normalizes legacy document identity when blocking a foreign source', async () => {
    const foreignSource = makeMutation('11111111-1111-4111-8111-111111111111', {
      id: 'foreign-legacy',
      mutationId: undefined,
      author: { uid: 'other-member', name: 'Other', role: 'dad' },
    })
    const foreignLegacyDocId = `${foreignSource.id}_${foreignSource.rev}`
    const forbiddenCanonical = deriveUploadReadyEvent(foreignSource, harness.auth.currentUser.uid)
    harness.localMutations = [foreignSource]
    harness.remote.set(foreignLegacyDocId, foreignSource)

    let engine = await connectEngine()
    expect(harness.remote.has(engine.makeDocId(forbiddenCanonical))).toBe(false)
    expect(harness.remote.size).toBe(1)
    engine.stop()
  })

  it('upgrades an owned source even when its exact legacy document is already remote', async () => {
    const ownedSource = makeMutation('22222222-2222-4222-8222-222222222222', {
      id: 'owned-legacy',
      mutationId: undefined,
    })
    const ownedLegacyDocId = `${ownedSource.id}_${ownedSource.rev}`
    const ownedCanonical = deriveUploadReadyEvent(ownedSource, harness.auth.currentUser.uid)
    harness.localMutations = [ownedSource]
    harness.remote.set(ownedLegacyDocId, ownedSource)

    const engine = await connectEngine()
    expect(harness.remote.has(ownedLegacyDocId)).toBe(true)
    expect(harness.remote.has(engine.makeDocId(ownedCanonical))).toBe(true)
    expect(harness.remote.size).toBe(2)
    engine.stop()
  })

  it('does not acknowledge an m3 pending mutation from an m2 snapshot of the same payload', async () => {
    const event = makeMutation('11111111-1111-4111-8111-111111111111')
    const engine = await connectEngine()
    harness.blockWrites = true
    engine.enqueue(event)

    const m2DocId = `m2|${encodeURIComponent(event.id)}|${event.rev}|${event.mutationId}`
    harness.snapshot!({
      docChanges: () => [{
        type: 'added',
        doc: { id: m2DocId, data: () => ({ event }) },
      }],
    })
    await vi.waitFor(() => {
      const pending = JSON.parse(localStorage.getItem('babydiary.pendingUploads') ?? '[]')
      expect(pending).toHaveLength(1)
    })

    harness.snapshot!({
      docChanges: () => [{
        type: 'added',
        doc: { id: engine.makeDocId(event), data: () => ({ event }) },
      }],
    })
    await vi.waitFor(() => {
      const pending = JSON.parse(localStorage.getItem('babydiary.pendingUploads') ?? '[]')
      expect(pending).toHaveLength(0)
    })
    engine.stop()
  })

  it('snapshot removes only its exact mutation and rejects malformed or mismatched cloud docs', async () => {
    const first = makeMutation('11111111-1111-4111-8111-111111111111')
    const second = makeMutation('22222222-2222-4222-8222-222222222222', { data: { note: 'second' } })
    const engine = await connectEngine()
    harness.blockWrites = true

    engine.enqueue(first)
    engine.enqueue(second)
    harness.snapshot!({
      docChanges: () => [{
        type: 'added',
        doc: { id: engine.makeDocId(first), data: () => ({ event: first }) },
      }],
    })
    await vi.waitFor(() => {
      const current = JSON.parse(localStorage.getItem('babydiary.pendingUploads') ?? '[]')
      expect(current).toHaveLength(1)
    })

    const pending = JSON.parse(localStorage.getItem('babydiary.pendingUploads') ?? '[]')
    expect(pending).toHaveLength(1)
    expect(pending[0].event.mutationId).toBe(second.mutationId)
    expect(harness.appended.filter(event => getEventStorageKey(event) === getEventStorageKey(first))).toEqual([first])

    const appendedBeforeInvalid = harness.appended.length
    harness.snapshot!({
      docChanges: () => [
        {
          type: 'added',
          doc: { id: '../../victim_2', data: () => ({ event: { ...first, id: '../../victim', mutationId: undefined } }) },
        },
        {
          type: 'added',
          doc: { id: engine.makeDocId(first), data: () => ({ event: second }) },
        },
      ],
    })
    await Promise.resolve()
    expect(harness.appended).toHaveLength(appendedBeforeInvalid)
    engine.stop()
  })
})
