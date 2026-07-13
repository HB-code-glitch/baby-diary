import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiaryEvent } from '../shared/types'

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
  snapshot: null as null | ((snapshot: { docChanges: () => unknown[] }) => void),
  blockWrites: false,
}))

vi.mock('../src/sync/firebase', () => ({
  initFirebase: vi.fn(async () => ({ auth: harness.auth, db: harness.db })),
  teardownFirebase: vi.fn(async () => undefined),
  fbSignIn: vi.fn(),
  fbSignUp: vi.fn(),
  fbSignOut: vi.fn(),
  getFirebaseAuth: vi.fn(() => harness.auth),
}))

vi.mock('../src/lib/ipc', () => ({
  ipc: {
    listEvents: vi.fn(async () => [...harness.localEvents]),
    listEventMutations: vi.fn(async () => [...harness.localMutations]),
    appendEvent: vi.fn(async (event: DiaryEvent) => {
      harness.appended.push(event)
      return 'ok'
    }),
    getSettings: vi.fn(async () => ({
      baby: { name: 'Sync Baby', birthdate: '2026-01-15' },
      profile: { uid: 'user-1', name: 'Parent', role: 'mom' as const },
      familyId: 'family-1',
      firebase: null,
    })),
    mergeSettings: vi.fn(async () => undefined),
    onEventAppended: vi.fn(() => () => undefined),
  },
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
    const event = harness.remote.get(ref.id)
    return { id: ref.id, exists: () => Boolean(event), data: () => ({ event }) }
  })

  const getDocs = vi.fn(async () => ({
    docs: [...harness.remote.entries()].map(([id, event]): FakeDoc => ({
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
    _ref: unknown,
    _options: unknown,
    callback: (snapshot: { docChanges: () => unknown[] }) => void,
  ) => {
    harness.snapshot = callback
    return () => undefined
  })

  return {
    ...actual,
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc: vi.fn(async () => undefined),
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
  const now = '2026-07-13T08:00:00.000Z'
  return {
    id: 'shared-event',
    mutationId,
    type: 'pee',
    at: now,
    data: {},
    author: { uid: 'user-1', name: 'Parent', role: 'mom' },
    createdAt: now,
    updatedAt: now,
    rev: 2,
    deleted: false,
    ...overrides,
  }
}

async function connectEngine() {
  const engine = await import('../src/sync/syncEngine')
  await engine.configure(config, 'family-1')
  engine.start()
  await vi.waitFor(() => expect(engine.getStatus().status).toBe('online'))
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
    harness.snapshot = null
    harness.blockWrites = false
  })

  it('persists both same-revision mutations in pending across a module restart', async () => {
    const first = makeMutation('11111111-1111-4111-8111-111111111111')
    const second = makeMutation('22222222-2222-4222-8222-222222222222', { data: { note: 'second' } })
    let engine = await import('../src/sync/syncEngine')

    engine.enqueue(first)
    engine.enqueue(second)
    engine.enqueue(first)

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

    expect(harness.remote.has(m2DocId)).toBe(true)
    expect(harness.remote.has(engine.makeDocId(event))).toBe(true)
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
    expect(harness.appended).toEqual([first])

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
