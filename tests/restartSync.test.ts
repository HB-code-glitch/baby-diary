import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../shared/types'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(ok => { resolve = ok })
  return { promise, resolve }
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

const harness = vi.hoisted(() => ({
  initFirebase: vi.fn(),
  teardownFirebase: vi.fn(),
  fbSignOut: vi.fn(),
  getDoc: vi.fn(),
  authListeners: new Set<(user: unknown) => void>(),
  authCallbacks: [] as Array<(user: unknown) => void>,
  snapshots: new Set<{ path: string; next: (value: unknown) => void; error: (error: Error) => void }>(),
  settings: {
    baby: { name: '', birthdate: '' },
    profile: { uid: 'user-1', name: 'Parent', role: 'mom' as const },
    familyId: 'family-A',
    firebase: null,
  } as AppSettings,
}))

vi.mock('../src/sync/firebase', () => ({
  initFirebase: (...args: unknown[]) => harness.initFirebase(...args),
  teardownFirebase: (...args: unknown[]) => harness.teardownFirebase(...args),
  fbSignIn: vi.fn(),
  fbSignUp: vi.fn(),
  fbSignOut: (...args: unknown[]) => harness.fbSignOut(...args),
  getFirebaseAuth: vi.fn(() => null),
}))

vi.mock('../src/lib/ipc', () => ({
  ipc: {
    listEvents: vi.fn(async () => []),
    listEventMutations: vi.fn(async () => []),
    appendEvent: vi.fn(async () => 'ok'),
    getSettings: vi.fn(async () => structuredClone(harness.settings)),
    mergeSettings: vi.fn(async (partial: Partial<AppSettings>) => {
      harness.settings = { ...harness.settings, ...partial }
      return structuredClone(harness.settings)
    }),
    saveSettings: vi.fn(async (settings: AppSettings) => settings),
    getBabyInfoSummary: vi.fn(async (familyId: string) => ({
      familyId,
      mutationCount: 0,
      pendingCount: 0,
      totalPendingCount: 0,
    })),
  },
}))

vi.mock('../src/sync/babyInfoSync', () => ({
  makeBabyInfoDocId: vi.fn(() => 'baby-info'),
  parseCloudBabyInfoDocument: vi.fn(() => null),
  persistSettingsWithBabyInfoMutation: vi.fn(),
  reconcileFamilyBabyInfo: vi.fn(async (options: { db: unknown }) => ({
    pendingCount: 0,
    activePendingCount: 0,
    needsRetry: false,
    uploadFailures: 0,
    settings: structuredClone(harness.settings),
    db: options.db,
  })),
  setBabyInfoPersistenceObserver: vi.fn(),
}))

vi.mock('firebase/auth', async () => {
  const actual = await vi.importActual<typeof import('firebase/auth')>('firebase/auth')
  return {
    ...actual,
    onAuthStateChanged: vi.fn((_auth: unknown, callback: (user: unknown) => void) => {
      harness.authListeners.add(callback)
      harness.authCallbacks.push(callback)
      return () => harness.authListeners.delete(callback)
    }),
  }
})

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore')
  const pathOf = (parent: unknown, segments: string[]) => {
    const prefix = parent && typeof parent === 'object' && 'path' in parent
      ? `${(parent as { path: string }).path}/`
      : ''
    return `${prefix}${segments.join('/')}`
  }
  return {
    ...actual,
    collection: vi.fn((parent: unknown, ...segments: string[]) => ({ path: pathOf(parent, segments) })),
    doc: vi.fn((parent: unknown, ...segments: string[]) => {
      const path = pathOf(parent, segments)
      return { path, id: path.split('/').at(-1) }
    }),
    query: vi.fn((ref: unknown) => ref),
    orderBy: vi.fn(() => ({})),
    documentId: vi.fn(() => '__name__'),
    startAfter: vi.fn(() => ({})),
    limit: vi.fn(() => ({})),
    getDoc: (...args: unknown[]) => harness.getDoc(...args),
    getDocs: vi.fn(async () => ({ docs: [] })),
    setDoc: vi.fn(async () => undefined),
    updateDoc: vi.fn(async () => undefined),
    onSnapshot: vi.fn((ref: { path: string }, ...args: unknown[]) => {
      const next = args.at(-3) as (value: unknown) => void
      const error = args.at(-2) as (error: Error) => void
      const registration = { path: ref.path, next, error }
      harness.snapshots.add(registration)
      return () => harness.snapshots.delete(registration)
    }),
    writeBatch: vi.fn(() => ({ set: vi.fn(), commit: vi.fn(async () => undefined) })),
    serverTimestamp: vi.fn(() => null),
  }
})

const config = (projectId: string) => ({
  apiKey: 'key',
  authDomain: 'example.test',
  projectId,
  storageBucket: 'bucket',
  messagingSenderId: 'sender',
  appId: 'app',
})

describe('serialized sync lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    localStorage.clear()
    harness.authListeners.clear()
    harness.authCallbacks.length = 0
    harness.snapshots.clear()
    harness.settings = {
      baby: { name: '', birthdate: '' },
      profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
      familyId: 'family-A',
      firebase: null,
    }
    harness.initFirebase.mockImplementation(async (cfg: { projectId: string }) => ({
      db: { projectId: cfg.projectId },
      auth: { projectId: cfg.projectId },
    }))
    harness.teardownFirebase.mockResolvedValue(undefined)
    harness.fbSignOut.mockResolvedValue(undefined)
    harness.getDoc.mockImplementation(async (ref: { path: string; id: string }) => ({
      id: ref.id,
      exists: () => ref.path === 'users/user-1',
      data: () => ref.path === 'users/user-1' ? { familyId: 'family-A' } : undefined,
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('begins old teardown before initializing replacement ownership without waiting for deletion', async () => {
    const teardown = deferred<void>()
    harness.teardownFirebase.mockReturnValueOnce(teardown.promise)
    const engine = await import('../src/sync/syncEngine')

    const restarting = engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.teardownFirebase).toHaveBeenCalledTimes(1))
    await restarting
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))
    expect(harness.initFirebase).toHaveBeenCalledTimes(1)
    expect(harness.teardownFirebase.mock.invocationCallOrder[0]).toBeLessThan(
      harness.initFirebase.mock.invocationCallOrder[0],
    )

    teardown.resolve()
    await flushMicrotasks()
    expect(harness.authListeners.size).toBe(1)
  })

  it('collapses rapid A → B → C restarts to the newest desired configuration', async () => {
    const firstInit = deferred<{ db: object; auth: object }>()
    harness.initFirebase.mockReturnValueOnce(firstInit.promise)
    const engine = await import('../src/sync/syncEngine')

    const a = engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.initFirebase).toHaveBeenCalledTimes(1))
    const b = engine.restartSync(config('project-B'), 'family-B')
    const c = engine.restartSync(config('project-C'), 'family-C')
    firstInit.resolve({ db: { projectId: 'project-A' }, auth: { projectId: 'project-A' } })
    await Promise.all([a, b, c])
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))

    const projects = harness.initFirebase.mock.calls.map(call => (call[0] as { projectId: string }).projectId)
    expect(projects.at(-1)).toBe('project-C')
    expect(projects).not.toContain('project-B')
    expect(harness.authListeners.size).toBe(1)
  })

  it('suppresses a stale auth callback after a replacement restart', async () => {
    const engine = await import('../src/sync/syncEngine')
    await engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.authCallbacks).toHaveLength(1))
    const staleCallback = harness.authCallbacks[0]

    await engine.restartSync(config('project-B'), 'family-B')
    await vi.waitFor(() => expect(harness.authCallbacks).toHaveLength(2))
    const readsBefore = harness.getDoc.mock.calls.length
    staleCallback({ uid: 'user-1', email: 'parent@example.test' })
    await Promise.resolve()

    expect(harness.getDoc).toHaveBeenCalledTimes(readsBefore)
    expect(engine.getStatus().status).toBe('signed-out')
    expect(harness.authListeners.size).toBe(1)
  })

  it('invalidates auth work immediately when sign-out begins, before signOut resolves', async () => {
    const signOut = deferred<void>()
    harness.fbSignOut.mockReturnValueOnce(signOut.promise)
    const engine = await import('../src/sync/syncEngine')
    await engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.authCallbacks).toHaveLength(1))
    const staleCallback = harness.authCallbacks[0]

    const signingOut = engine.signOutSync()
    staleCallback({ uid: 'user-1', email: 'parent@example.test' })
    await Promise.resolve()
    expect(harness.getDoc).not.toHaveBeenCalled()

    signOut.resolve()
    await signingOut
    expect(engine.getStatus().status).toBe('signed-out')
  })

  it('duplicate start calls are awaitable and leave one auth listener', async () => {
    const engine = await import('../src/sync/syncEngine')
    await engine.configure(config('project-A'), 'family-A')
    await Promise.all([engine.start(), engine.start(), engine.start()])

    expect(harness.authListeners.size).toBe(1)
  })

  it('stops immediately while a signed-in network read never resolves', async () => {
    const userRead = deferred<never>()
    harness.getDoc.mockImplementationOnce(() => userRead.promise)
    const engine = await import('../src/sync/syncEngine')
    await engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.authCallbacks).toHaveLength(1))

    harness.authCallbacks[0]({ uid: 'user-1', email: 'parent@example.test' })
    await vi.waitFor(() => expect(harness.getDoc).toHaveBeenCalledTimes(1))

    const stopping = engine.stop()
    expect(harness.authListeners.size).toBe(0)
    expect(harness.snapshots.size).toBe(0)
    expect(engine.getStatus().status).toBe('off')
    await stopping
  })

  it('logs out immediately while a signed-in network read never resolves', async () => {
    const userRead = deferred<never>()
    harness.getDoc.mockImplementationOnce(() => userRead.promise)
    const engine = await import('../src/sync/syncEngine')
    await engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.authCallbacks).toHaveLength(1))

    harness.authCallbacks[0]({ uid: 'user-1', email: 'parent@example.test' })
    await vi.waitFor(() => expect(harness.getDoc).toHaveBeenCalledTimes(1))

    const signingOut = engine.signOutSync()
    expect(harness.authListeners.size).toBe(0)
    expect(harness.snapshots.size).toBe(0)
    expect(engine.getStatus().status).toBe('signed-out')
    await signingOut
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))
  })

  it('restarts immediately while the replaced signed-in network read never resolves', async () => {
    const userRead = deferred<never>()
    harness.getDoc.mockImplementationOnce(() => userRead.promise)
    const engine = await import('../src/sync/syncEngine')
    await engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.authCallbacks).toHaveLength(1))

    harness.authCallbacks[0]({ uid: 'user-1', email: 'parent@example.test' })
    await vi.waitFor(() => expect(harness.getDoc).toHaveBeenCalledTimes(1))

    const restarting = engine.restartSync(config('project-B'), 'family-B')
    expect(harness.authListeners.size).toBe(0)
    expect(harness.snapshots.size).toBe(0)
    await restarting
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))
    expect(harness.initFirebase.mock.calls.at(-1)?.[0]).toMatchObject({ projectId: 'project-B' })
  })

  it('finishes local stop even when Firebase teardown never resolves', async () => {
    const engine = await import('../src/sync/syncEngine')
    await engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))
    harness.teardownFirebase.mockReturnValueOnce(deferred<void>().promise)

    let settled = false
    const stopping = engine.stop().then(() => { settled = true })
    expect(harness.authListeners.size).toBe(0)
    expect(engine.getStatus().status).toBe('off')
    await flushMicrotasks()

    expect(settled).toBe(true)
    await stopping
  })

  it('starts the newest config while an old Firebase teardown never resolves', async () => {
    const engine = await import('../src/sync/syncEngine')
    await engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))
    harness.teardownFirebase.mockReturnValueOnce(deferred<void>().promise)

    const restarting = engine.restartSync(config('project-B'), 'family-B')
    expect(harness.authListeners.size).toBe(0)
    await vi.waitFor(() => expect(harness.initFirebase).toHaveBeenCalledTimes(2), { timeout: 250 })
    await restarting
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))
    expect(harness.initFirebase.mock.calls.at(-1)?.[0]).toMatchObject({ projectId: 'project-B' })
  })

  it('bounds persisted sign-out and reports that remote logout is incomplete', async () => {
    const engine = await import('../src/sync/syncEngine')
    await engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))
    harness.fbSignOut.mockReturnValueOnce(deferred<void>().promise)
    vi.useFakeTimers()

    const signingOut = engine.signOutSync()
    const rejected = expect(signingOut).rejects.toMatchObject({ code: 'SIGN_OUT_TIMEOUT' })
    expect(harness.authListeners.size).toBe(0)
    expect(engine.getStatus().status).toBe('signed-out')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(engine.SIGN_OUT_TIMEOUT_MS)

    await rejected
    expect(engine.getStatus()).toMatchObject({
      status: 'error',
      detail: engine.DETAIL_SIGN_OUT_INCOMPLETE,
    })
    expect(harness.authListeners.size).toBe(0)
  })
})
