import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../shared/types'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
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
  emitCurrentUserOnSubscribe: false,
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
    onAuthStateChanged: vi.fn((auth: unknown, callback: (user: unknown) => void) => {
      harness.authListeners.add(callback)
      harness.authCallbacks.push(callback)
      if (harness.emitCurrentUserOnSubscribe) {
        callback((auth as { currentUser?: unknown }).currentUser ?? null)
      }
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
    harness.emitCurrentUserOnSubscribe = false
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

  it('starts replacement initialization while the previous Firebase init is still held', async () => {
    const firstInit = deferred<{ db: object; auth: object }>()
    harness.initFirebase.mockReturnValueOnce(firstInit.promise)
    const engine = await import('../src/sync/syncEngine')
    const a = engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.initFirebase).toHaveBeenCalledTimes(1))

    const b = engine.restartSync(config('project-B'), 'family-B')
    try {
      await vi.waitFor(() => expect(harness.initFirebase).toHaveBeenCalledTimes(2), { timeout: 250 })
      expect(harness.initFirebase.mock.calls.at(-1)?.[0]).toMatchObject({ projectId: 'project-B' })
      await b
      expect(harness.authListeners.size).toBe(1)
    } finally {
      firstInit.resolve({ db: { projectId: 'project-A' }, auth: { projectId: 'project-A' } })
      await Promise.allSettled([a, b])
    }
  })

  it('finishes local stop while Firebase initialization is still held', async () => {
    const firstInit = deferred<{ db: object; auth: object }>()
    harness.initFirebase.mockReturnValueOnce(firstInit.promise)
    const engine = await import('../src/sync/syncEngine')
    const restarting = engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.initFirebase).toHaveBeenCalledTimes(1))

    let stopped = false
    const stopping = engine.stop().then(() => { stopped = true })
    try {
      await flushMicrotasks()
      expect(stopped).toBe(true)
      expect(engine.getStatus().status).toBe('detached')
      expect(harness.authListeners.size).toBe(0)
      await stopping
    } finally {
      firstInit.resolve({ db: { projectId: 'project-A' }, auth: { projectId: 'project-A' } })
      await Promise.allSettled([restarting, stopping])
    }
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
    expect(engine.getStatus().status).toBe('signing-out')

    signOut.resolve()
    await signingOut
    expect(engine.getStatus().status).toBe('signed-out')
  })

  it('holds sign-out for pending Firebase initialization, signs out once, then installs one listener', async () => {
    const pendingInit = deferred<{ db: object; auth: { currentUser: unknown } }>()
    harness.initFirebase.mockReturnValueOnce(pendingInit.promise)
    harness.emitCurrentUserOnSubscribe = true
    harness.fbSignOut.mockImplementationOnce(async (auth: { currentUser: unknown }) => {
      auth.currentUser = null
    })
    const engine = await import('../src/sync/syncEngine')
    const restarting = engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.initFirebase).toHaveBeenCalledTimes(1))

    let settled = false
    const signingOut = engine.signOutSync().then(() => { settled = true })
    await flushMicrotasks()
    expect(settled).toBe(false)
    expect(engine.getStatus().status).toBe('signing-out')
    expect(harness.fbSignOut).not.toHaveBeenCalled()

    const auth = { currentUser: { uid: 'persisted-user', email: 'persisted@example.test' } }
    pendingInit.resolve({ db: { projectId: 'project-A' }, auth })
    await Promise.all([restarting, signingOut])

    expect(harness.fbSignOut).toHaveBeenCalledTimes(1)
    expect(harness.fbSignOut).toHaveBeenCalledWith(auth)
    expect(auth.currentUser).toBeNull()
    expect(engine.getStatus().status).toBe('signed-out')
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))
    expect(harness.getDoc).not.toHaveBeenCalled()
  })

  it('maps pending Firebase initialization rejection to structured sign-out failure', async () => {
    const pendingInit = deferred<{ db: object; auth: object }>()
    harness.initFirebase.mockReturnValueOnce(pendingInit.promise)
    const engine = await import('../src/sync/syncEngine')
    const restarting = engine.restartSync(config('project-A'), 'family-A')
    const restartFailure = restarting.catch(error => error)
    await vi.waitFor(() => expect(harness.initFirebase).toHaveBeenCalledTimes(1))

    const signingOut = engine.signOutSync()
    expect(engine.getStatus().status).toBe('signing-out')
    pendingInit.reject(new Error('held initialization rejected'))

    await expect(signingOut).rejects.toMatchObject({ code: 'SIGN_OUT_FAILED' })
    expect(await restartFailure).toBeInstanceOf(Error)
    expect(engine.getStatus()).toMatchObject({
      status: 'error',
      detail: engine.DETAIL_SIGN_OUT_FAILED,
    })
    expect(harness.fbSignOut).not.toHaveBeenCalled()
  })

  it('times out instead of claiming success while Firebase initialization never settles', async () => {
    harness.initFirebase.mockReturnValueOnce(deferred<{ db: object; auth: object }>().promise)
    const engine = await import('../src/sync/syncEngine')
    void engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.initFirebase).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()

    const signingOut = engine.signOutSync()
    const rejected = expect(signingOut).rejects.toMatchObject({ code: 'SIGN_OUT_TIMEOUT' })
    await flushMicrotasks()
    expect(engine.getStatus().status).toBe('signing-out')
    expect(harness.fbSignOut).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(engine.SIGN_OUT_TIMEOUT_MS)

    await rejected
    expect(engine.getStatus()).toMatchObject({
      status: 'error',
      detail: engine.DETAIL_SIGN_OUT_TIMEOUT,
    })
  })

  it('treats only genuinely unconfigured sign-out as an immediate remote no-op', async () => {
    const engine = await import('../src/sync/syncEngine')

    await expect(engine.signOutSync()).resolves.toBeUndefined()

    expect(harness.initFirebase).not.toHaveBeenCalled()
    expect(harness.fbSignOut).not.toHaveBeenCalled()
    expect(engine.getStatus().status).toBe('no-config')
  })

  it('supersedes a pending-init sign-out without signing out the newer restart lease', async () => {
    const firstInit = deferred<{ db: object; auth: object }>()
    harness.initFirebase.mockReturnValueOnce(firstInit.promise)
    const engine = await import('../src/sync/syncEngine')
    const firstRestart = engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.initFirebase).toHaveBeenCalledTimes(1))
    const signingOut = engine.signOutSync()

    const newestRestart = engine.restartSync(config('project-B'), 'family-B')
    await expect(signingOut).rejects.toMatchObject({ code: 'SIGN_OUT_SUPERSEDED' })
    await newestRestart
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))

    firstInit.resolve({ db: { projectId: 'project-A' }, auth: { projectId: 'project-A' } })
    await firstRestart
    await flushMicrotasks()
    expect(harness.fbSignOut).not.toHaveBeenCalled()
    expect(harness.authListeners.size).toBe(1)
    expect(harness.initFirebase.mock.calls.at(-1)?.[0]).toMatchObject({ projectId: 'project-B' })
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
    expect(engine.getStatus().status).toBe('detached')
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
    expect(engine.getStatus().status).toBe('signing-out')
    await signingOut
    expect(engine.getStatus().status).toBe('signed-out')
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
    expect(engine.getStatus().status).toBe('detached')
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
    expect(engine.getStatus().status).toBe('signing-out')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(engine.SIGN_OUT_TIMEOUT_MS)

    await rejected
    expect(engine.getStatus()).toMatchObject({
      status: 'error',
      detail: engine.DETAIL_SIGN_OUT_TIMEOUT,
    })
    expect(harness.authListeners.size).toBe(0)
  })

  it('rejects a held sign-out as superseded while the newest restart installs its listener', async () => {
    const engine = await import('../src/sync/syncEngine')
    await engine.restartSync(config('project-A'), 'family-A')
    await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))
    const remoteSignOut = deferred<void>()
    harness.fbSignOut.mockReturnValueOnce(remoteSignOut.promise)
    const observed: string[] = []
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const unsubscribe = engine.subscribeStatus(state => observed.push(state.status))

    const signingOut = engine.signOutSync()
    expect(engine.getStatus().status).toBe('signing-out')
    const restarting = engine.restartSync(config('project-B'), 'family-B')
    try {
      await expect(signingOut).rejects.toMatchObject({ code: 'SIGN_OUT_SUPERSEDED' })
      await restarting
      await vi.waitFor(() => expect(harness.authListeners.size).toBe(1))
      expect(observed).toContain('superseded')
      expect(harness.initFirebase.mock.calls.at(-1)?.[0]).toMatchObject({ projectId: 'project-B' })
    } finally {
      unsubscribe()
      remoteSignOut.reject(new Error('late remote sign-out rejection'))
      await flushMicrotasks()
      process.off('unhandledRejection', unhandled)
    }
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('reports an active remote sign-out rejection as failure without claiming signed-out', async () => {
    const engine = await import('../src/sync/syncEngine')
    await engine.restartSync(config('project-A'), 'family-A')
    harness.fbSignOut.mockRejectedValueOnce(new Error('remote auth unavailable'))

    const signingOut = engine.signOutSync()
    expect(engine.getStatus().status).toBe('signing-out')
    await expect(signingOut).rejects.toMatchObject({ code: 'SIGN_OUT_FAILED' })
    expect(engine.getStatus()).toMatchObject({
      status: 'error',
      detail: engine.DETAIL_SIGN_OUT_FAILED,
    })
  })
})
