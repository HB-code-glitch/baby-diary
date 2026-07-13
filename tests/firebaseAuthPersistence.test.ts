import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const FIREBASE_REGISTRY = Symbol.for('baby-diary.firebase.service-registry.v1')

const emulatorBridge = vi.hoisted(() => ({
  getFirebaseEmulator: vi.fn<() => Promise<null>>(async () => null),
}))

const firebase = vi.hoisted(() => {
  type MockConfig = {
    apiKey: string
    authDomain: string
    projectId: string
    storageBucket: string
    messagingSenderId: string
    appId: string
  }
  type MockApp = { name: string; options: MockConfig; deleted: boolean }
  type MockDb = { kind: 'db'; app: MockApp; sequence: number; terminated: boolean }
  type MockAuth = {
    kind: 'auth'
    app: MockApp
    sequence: number
    currentUser: { uid: string } | null
  }

  const apps: MockApp[] = []
  const dbByApp = new Map<MockApp, MockDb>()
  const authByApp = new Map<MockApp, MockAuth>()
  let serviceSequence = 0
  let maximumAppCount = 0

  const initializeApp = vi.fn()
  const getApps = vi.fn()
  const deleteApp = vi.fn()
  const initializeFirestore = vi.fn()
  const getFirestore = vi.fn()
  const terminate = vi.fn()
  const persistentLocalCache = vi.fn((options: unknown) => options)
  const persistentMultipleTabManager = vi.fn(() => ({ type: 'multi-tab' }))
  const connectFirestoreEmulator = vi.fn()
  const getAuth = vi.fn()
  const connectAuthEmulator = vi.fn()
  const setPersistence = vi.fn()
  const signInWithEmailAndPassword = vi.fn()
  const createUserWithEmailAndPassword = vi.fn()

  const installDefaults = () => {
    initializeApp.mockImplementation((options: MockConfig, name: string) => {
      const app: MockApp = { name, options: { ...options }, deleted: false }
      apps.push(app)
      maximumAppCount = Math.max(maximumAppCount, apps.length)
      return app
    })
    getApps.mockImplementation(() => [...apps])
    deleteApp.mockImplementation(async (app: MockApp) => {
      app.deleted = true
      const index = apps.indexOf(app)
      if (index >= 0) apps.splice(index, 1)
      dbByApp.delete(app)
      authByApp.delete(app)
    })
    initializeFirestore.mockImplementation((app: MockApp) => {
      const db: MockDb = {
        kind: 'db',
        app,
        sequence: ++serviceSequence,
        terminated: false,
      }
      dbByApp.set(app, db)
      return db
    })
    getFirestore.mockImplementation((app: MockApp) => {
      const existing = dbByApp.get(app)
      if (existing) return existing
      const db: MockDb = {
        kind: 'db',
        app,
        sequence: ++serviceSequence,
        terminated: false,
      }
      dbByApp.set(app, db)
      return db
    })
    terminate.mockImplementation(async (db: MockDb) => {
      db.terminated = true
    })
    getAuth.mockImplementation((app: MockApp) => {
      const existing = authByApp.get(app)
      if (existing) return existing
      const auth: MockAuth = {
        kind: 'auth',
        app,
        sequence: ++serviceSequence,
        currentUser: null,
      }
      authByApp.set(app, auth)
      return auth
    })
    connectFirestoreEmulator.mockImplementation(() => undefined)
    connectAuthEmulator.mockImplementation(() => undefined)
    setPersistence.mockResolvedValue(undefined)
    signInWithEmailAndPassword.mockResolvedValue({ user: { uid: 'login-user' } })
    createUserWithEmailAndPassword.mockResolvedValue({ user: { uid: 'signup-user' } })
  }

  const reset = () => {
    apps.length = 0
    dbByApp.clear()
    authByApp.clear()
    serviceSequence = 0
    maximumAppCount = 0
    for (const mock of [
      initializeApp,
      getApps,
      deleteApp,
      initializeFirestore,
      getFirestore,
      terminate,
      persistentLocalCache,
      persistentMultipleTabManager,
      connectFirestoreEmulator,
      getAuth,
      connectAuthEmulator,
      setPersistence,
      signInWithEmailAndPassword,
      createUserWithEmailAndPassword,
    ]) {
      mock.mockReset()
    }
    persistentLocalCache.mockImplementation((options: unknown) => options)
    persistentMultipleTabManager.mockImplementation(() => ({ type: 'multi-tab' }))
    installDefaults()
  }

  installDefaults()

  return {
    apps,
    initializeApp,
    getApps,
    deleteApp,
    initializeFirestore,
    getFirestore,
    terminate,
    persistentLocalCache,
    persistentMultipleTabManager,
    connectFirestoreEmulator,
    getAuth,
    connectAuthEmulator,
    setPersistence,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    local: { type: 'LOCAL' },
    session: { type: 'SESSION' },
    credentialAuth: { currentUser: null as { uid: string } | null },
    maximumAppCount: () => maximumAppCount,
    reset,
  }
})

vi.mock('../src/lib/ipc', () => ({
  ipc: {
    getFirebaseEmulator: () => emulatorBridge.getFirebaseEmulator(),
  },
}))

vi.mock('firebase/app', () => ({
  initializeApp: firebase.initializeApp,
  getApps: firebase.getApps,
  deleteApp: firebase.deleteApp,
}))

vi.mock('firebase/firestore', () => ({
  getFirestore: firebase.getFirestore,
  initializeFirestore: firebase.initializeFirestore,
  terminate: firebase.terminate,
  persistentLocalCache: firebase.persistentLocalCache,
  persistentMultipleTabManager: firebase.persistentMultipleTabManager,
  connectFirestoreEmulator: firebase.connectFirestoreEmulator,
}))

vi.mock('firebase/auth', () => ({
  getAuth: firebase.getAuth,
  connectAuthEmulator: firebase.connectAuthEmulator,
  setPersistence: firebase.setPersistence,
  browserLocalPersistence: firebase.local,
  browserSessionPersistence: firebase.session,
  signInWithEmailAndPassword: firebase.signInWithEmailAndPassword,
  createUserWithEmailAndPassword: firebase.createUserWithEmailAndPassword,
}))

const config = {
  apiKey: 'key',
  authDomain: 'example.test',
  projectId: 'project-a',
  storageBucket: 'bucket',
  messagingSenderId: 'sender',
  appId: 'app',
}

const configFor = (projectId: string) => ({ ...config, projectId })

describe('Firebase auth persistence and service leases', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (globalThis as unknown as Record<PropertyKey, unknown>)[FIREBASE_REGISTRY]
    firebase.reset()
    emulatorBridge.getFirebaseEmulator.mockReset()
    emulatorBridge.getFirebaseEmulator.mockResolvedValue(null)
  })

  it('preserves a restored session choice during renderer reload', async () => {
    firebase.credentialAuth.currentUser = { uid: 'session-user' }
    firebase.getAuth.mockReturnValueOnce(firebase.credentialAuth)
    const { initFirebase } = await import('../src/sync/firebase')

    const result = await initFirebase(config)

    expect(result?.auth).toBe(firebase.credentialAuth)
    expect(firebase.credentialAuth.currentUser).toEqual({ uid: 'session-user' })
    expect(firebase.setPersistence).not.toHaveBeenCalled()
  })

  it('shares one production initialization for concurrent same-config requests', async () => {
    const bridge = deferred<null>()
    emulatorBridge.getFirebaseEmulator.mockReturnValue(bridge.promise)
    const { initFirebase } = await import('../src/sync/firebase')

    const first = initFirebase(config, 'owner-a')
    const second = initFirebase({ ...config }, 'owner-b')
    bridge.resolve(null)

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(firstResult?.db).toBe(secondResult?.db)
    expect(firebase.initializeApp).toHaveBeenCalledOnce()
    expect(firebase.initializeFirestore).toHaveBeenCalledOnce()
  })

  it('does not choose persistence while initializing or recreating Firebase', async () => {
    const { initFirebase, teardownFirebase } = await import('../src/sync/firebase')

    await initFirebase(config)
    await initFirebase({ ...config })
    expect(firebase.initializeApp).toHaveBeenCalledOnce()
    expect(firebase.setPersistence).not.toHaveBeenCalled()

    await teardownFirebase()
    await initFirebase(config)
    expect(firebase.initializeApp).toHaveBeenCalledTimes(2)
    expect(firebase.terminate).toHaveBeenCalledOnce()
    expect(firebase.deleteApp).toHaveBeenCalledOnce()
    expect(firebase.setPersistence).not.toHaveBeenCalled()
  })

  it('keeps a newer module-reset lease alive when the stale module tears down', async () => {
    const firstModule = await import('../src/sync/firebase')
    const first = await firstModule.initFirebase(config, 'owner-a')

    vi.resetModules()
    const secondModule = await import('../src/sync/firebase')
    const second = await secondModule.initFirebase({ ...config }, 'owner-b')
    const stableApp = firebase.apps[0]
    expect(second).toEqual(first)

    await firstModule.teardownFirebase()
    expect(firebase.terminate).not.toHaveBeenCalled()
    expect(secondModule.getDb()).toBe(second?.db)

    await secondModule.teardownFirebase()
    expect(firebase.terminate).toHaveBeenCalledWith(second?.db)
    expect(firebase.deleteApp).toHaveBeenCalledWith(stableApp)
    expect(firebase.apps).toHaveLength(0)
  })

  it('releases a prior config lease with terminate before deleteApp', async () => {
    const module = await import('../src/sync/firebase')
    const first = await module.initFirebase(configFor('project-a'), 'lease-a')
    const firstApp = firebase.apps[0]

    const second = await module.initFirebase(configFor('project-b'), 'lease-b')
    await vi.waitFor(() => expect(firebase.deleteApp).toHaveBeenCalledWith(firstApp))

    expect(firebase.terminate).toHaveBeenCalledWith(first?.db)
    expect(firebase.terminate.mock.invocationCallOrder[0]).toBeLessThan(
      firebase.deleteApp.mock.invocationCallOrder[0],
    )
    expect(module.getDb()).toBe(second?.db)
    expect(firebase.apps.map(app => app.options.projectId)).toEqual(['project-b'])
  })

  it('keeps A deterministic through A -> B -> A and removes inactive B', async () => {
    const module = await import('../src/sync/firebase')
    const identityA = module.getFirebasePersistenceIdentity(configFor('project-a'))

    await module.initFirebase(configFor('project-a'), 'lease-a1')
    await module.initFirebase(configFor('project-b'), 'lease-b')
    await vi.waitFor(() => expect(firebase.apps.map(app => app.options.projectId)).toEqual(['project-b']))
    await module.initFirebase(configFor('project-a'), 'lease-a2')
    await vi.waitFor(() => expect(firebase.apps.map(app => app.options.projectId)).toEqual(['project-a']))

    expect(firebase.apps[0]?.name).toBe(identityA.appName)
    expect(firebase.apps.some(app => app.options.projectId === 'project-b')).toBe(false)
    expect(firebase.initializeApp.mock.calls
      .filter(call => (call[0] as typeof config).projectId === 'project-a')
      .map(call => call[1])).toEqual([identityA.appName, identityA.appName])
  })

  it('cancels stale post-terminate deletion and recreates before returning on reactivation', async () => {
    const heldTerminate = deferred<void>()
    firebase.terminate.mockImplementationOnce(async (db: { terminated: boolean }) => {
      await heldTerminate.promise
      db.terminated = true
    })
    const module = await import('../src/sync/firebase')
    const first = await module.initFirebase(config, 'lease-a1')

    const staleCleanup = module.teardownFirebase()
    await vi.waitFor(() => expect(firebase.terminate).toHaveBeenCalledWith(first?.db))
    const reactivated = module.initFirebase(config, 'lease-a2')

    let reactivationSettled = false
    void reactivated.finally(() => { reactivationSettled = true })
    await Promise.resolve()
    expect(reactivationSettled).toBe(false)

    heldTerminate.resolve()
    await Promise.resolve()
    expect(firebase.deleteApp).not.toHaveBeenCalled()
    await staleCleanup

    const replacement = await reactivated
    expect(replacement?.db).not.toBe(first?.db)
    expect((first?.db as unknown as { terminated: boolean }).terminated).toBe(true)
    expect(firebase.deleteApp).toHaveBeenCalledOnce()
    expect(firebase.initializeApp).toHaveBeenCalledTimes(2)
  })

  it('waits for an in-flight delete and recreates without deleting the old app twice', async () => {
    const heldDelete = deferred<void>()
    const deleteNormally = firebase.deleteApp.getMockImplementation() as (
      app: (typeof firebase.apps)[number],
    ) => Promise<void>
    firebase.deleteApp.mockImplementationOnce(async app => {
      await heldDelete.promise
      await deleteNormally(app)
    })
    const module = await import('../src/sync/firebase')
    const first = await module.initFirebase(config, 'lease-a1')

    const cleanup = module.teardownFirebase()
    await vi.waitFor(() => expect(firebase.deleteApp).toHaveBeenCalledOnce())
    const reactivated = module.initFirebase(config, 'lease-a2')

    heldDelete.resolve()
    await cleanup
    const replacement = await reactivated

    expect(replacement?.db).not.toBe(first?.db)
    expect(firebase.deleteApp).toHaveBeenCalledOnce()
    expect(firebase.initializeApp).toHaveBeenCalledTimes(2)
  })

  it('surfaces terminate failure and retries the retained cleanup state', async () => {
    firebase.terminate.mockRejectedValueOnce(new Error('terminate unavailable'))
    const module = await import('../src/sync/firebase')
    await module.initFirebase(config)

    await expect(module.teardownFirebase()).rejects.toThrow('terminate unavailable')
    expect(firebase.deleteApp).not.toHaveBeenCalled()
    expect(firebase.apps).toHaveLength(1)

    await expect(module.teardownFirebase()).resolves.toBeUndefined()
    expect(firebase.terminate).toHaveBeenCalledTimes(2)
    expect(firebase.deleteApp).toHaveBeenCalledOnce()
    expect(firebase.apps).toHaveLength(0)
  })

  it('surfaces a background config-replacement cleanup failure before retrying it', async () => {
    firebase.terminate.mockRejectedValueOnce(new Error('background terminate unavailable'))
    const module = await import('../src/sync/firebase')
    await module.initFirebase(configFor('project-a'), 'lease-a')

    await module.initFirebase(configFor('project-b'), 'lease-b')
    await vi.waitFor(() => expect(firebase.terminate).toHaveBeenCalledOnce())
    await Promise.resolve()

    await expect(module.teardownFirebase()).rejects.toThrow('background terminate unavailable')
    expect(firebase.apps.some(app => app.options.projectId === 'project-a')).toBe(true)

    await expect(module.teardownFirebase()).resolves.toBeUndefined()
    expect(firebase.apps).toHaveLength(0)
  })

  it('surfaces delete failure and retries without returning the terminated service', async () => {
    firebase.deleteApp.mockRejectedValueOnce(new Error('delete unavailable'))
    const module = await import('../src/sync/firebase')
    const first = await module.initFirebase(config)

    await expect(module.teardownFirebase()).rejects.toThrow('delete unavailable')
    expect(firebase.terminate).toHaveBeenCalledOnce()
    expect(firebase.apps).toHaveLength(1)

    const retry = module.initFirebase(config, 'retry-owner')
    const replacement = await retry
    expect(replacement?.db).not.toBe(first?.db)
    expect(firebase.terminate).toHaveBeenCalledOnce()
    expect(firebase.deleteApp).toHaveBeenCalledTimes(2)
    expect(firebase.initializeApp).toHaveBeenCalledTimes(2)
  })

  it('keeps the registry and installed-app set bounded across many configs', async () => {
    const module = await import('../src/sync/firebase')

    for (let index = 0; index < 24; index += 1) {
      await module.initFirebase(configFor(`project-${index}`), `owner-${index}`)
      await module.teardownFirebase()
    }

    expect(firebase.apps).toHaveLength(0)
    expect(firebase.maximumAppCount()).toBeLessThanOrEqual(1)
    expect(firebase.initializeApp).toHaveBeenCalledTimes(24)
    expect(firebase.deleteApp).toHaveBeenCalledTimes(24)
  })

  it('keeps concurrent module-reset config reservations bounded and tracked', async () => {
    const bridge = deferred<null>()
    emulatorBridge.getFirebaseEmulator.mockReturnValue(bridge.promise)
    const runs: Array<{
      module: typeof import('../src/sync/firebase')
      result: ReturnType<typeof import('../src/sync/firebase')['initFirebase']>
    }> = []

    for (let index = 0; index < 12; index += 1) {
      vi.resetModules()
      const module = await import('../src/sync/firebase')
      runs.push({
        module,
        result: module.initFirebase(configFor(`parallel-${index}`), `parallel-${index}`),
      })
    }

    bridge.resolve(null)
    const settled = await Promise.allSettled(runs.map(run => run.result))

    const teardowns: PromiseSettledResult<void>[] = []
    for (const run of [...runs].reverse()) {
      teardowns.push(...await Promise.allSettled([run.module.teardownFirebase()]))
    }

    expect(settled.every(result => result.status === 'fulfilled')).toBe(true)
    const last = settled.at(-1)
    expect(last?.status === 'fulfilled' ? last.value : null).not.toBeNull()
    expect(teardowns.every(result => result.status === 'fulfilled')).toBe(true)
    expect(firebase.apps).toHaveLength(0)
    expect(firebase.maximumAppCount()).toBeLessThanOrEqual(4)
  })

  it('uses one deterministic app identity across owners and module reloads', async () => {
    let module = await import('../src/sync/firebase')
    await module.initFirebase(config, 'owner-a')
    const firstName = firebase.initializeApp.mock.calls[0]?.[1]
    const firstIdentity = module.getFirebasePersistenceIdentity(config)
    await module.teardownFirebase()

    vi.resetModules()
    module = await import('../src/sync/firebase')
    await module.initFirebase({ ...config }, 'owner-b')
    const secondName = firebase.initializeApp.mock.calls.at(-1)?.[1]
    const secondIdentity = module.getFirebasePersistenceIdentity({ ...config })

    expect(firstName).toMatch(/^baby-diary-[a-f0-9]{16}$/)
    expect(secondName).toBe(firstName)
    expect(secondIdentity).toEqual(firstIdentity)
    expect(String(firstName)).not.toContain('owner')
  })

  it('keeps omitted keepLoggedIn as a local-persistence sign-in', async () => {
    const { fbSignIn } = await import('../src/sync/firebase')

    await fbSignIn(firebase.credentialAuth as never, 'parent@example.test', 'secret1')

    expect(firebase.setPersistence).toHaveBeenCalledWith(firebase.credentialAuth, firebase.local)
    expect(firebase.signInWithEmailAndPassword).toHaveBeenCalledOnce()
  })

  it('keeps omitted keepLoggedIn as a local-persistence sign-up', async () => {
    const { fbSignUp } = await import('../src/sync/firebase')

    await fbSignUp(firebase.credentialAuth as never, 'parent@example.test', 'secret1')

    expect(firebase.setPersistence).toHaveBeenCalledWith(firebase.credentialAuth, firebase.local)
    expect(firebase.createUserWithEmailAndPassword).toHaveBeenCalledOnce()
  })

  it.each([
    ['local', true, firebase.local],
    ['session', false, firebase.session],
  ] as const)('sets %s persistence before signing in', async (_name, keepLoggedIn, expectedPersistence) => {
    const { fbSignIn } = await import('../src/sync/firebase')

    await fbSignIn(firebase.credentialAuth as never, 'parent@example.test', 'secret1', keepLoggedIn)

    expect(firebase.setPersistence).toHaveBeenCalledWith(firebase.credentialAuth, expectedPersistence)
    expect(firebase.signInWithEmailAndPassword).toHaveBeenCalledWith(
      firebase.credentialAuth,
      'parent@example.test',
      'secret1',
    )
    expect(firebase.setPersistence.mock.invocationCallOrder[0]).toBeLessThan(
      firebase.signInWithEmailAndPassword.mock.invocationCallOrder[0],
    )
  })

  it.each([
    ['local', true, firebase.local],
    ['session', false, firebase.session],
  ] as const)('sets %s persistence before creating an account', async (_name, keepLoggedIn, expectedPersistence) => {
    const { fbSignUp } = await import('../src/sync/firebase')

    await fbSignUp(firebase.credentialAuth as never, 'parent@example.test', 'secret1', keepLoggedIn)

    expect(firebase.setPersistence).toHaveBeenCalledWith(firebase.credentialAuth, expectedPersistence)
    expect(firebase.createUserWithEmailAndPassword).toHaveBeenCalledWith(
      firebase.credentialAuth,
      'parent@example.test',
      'secret1',
    )
    expect(firebase.setPersistence.mock.invocationCallOrder[0]).toBeLessThan(
      firebase.createUserWithEmailAndPassword.mock.invocationCallOrder[0],
    )
  })

  it('propagates persistence failures and never starts credential sign-in', async () => {
    const { fbSignIn } = await import('../src/sync/firebase')
    firebase.setPersistence.mockRejectedValueOnce(new Error('persistence unavailable'))

    await expect(
      fbSignIn(firebase.credentialAuth as never, 'parent@example.test', 'secret1', true),
    ).rejects.toThrow('persistence unavailable')
    expect(firebase.signInWithEmailAndPassword).not.toHaveBeenCalled()
  })
})
