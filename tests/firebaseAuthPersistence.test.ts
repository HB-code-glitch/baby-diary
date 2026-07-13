import { beforeEach, describe, expect, it, vi } from 'vitest'

const firebase = vi.hoisted(() => {
  const app = { name: 'baby-diary' }
  const auth = { name: 'auth' }
  const db = { name: 'db' }
  const local = { type: 'LOCAL' }
  const session = { type: 'SESSION' }

  return {
    app,
    auth,
    db,
    local,
    session,
    initializeApp: vi.fn(() => app),
    getApps: vi.fn(() => [] as Array<{ name: string }>),
    deleteApp: vi.fn(async () => undefined),
    initializeFirestore: vi.fn(() => db),
    persistentLocalCache: vi.fn((options: unknown) => options),
    persistentMultipleTabManager: vi.fn(() => ({ type: 'multi-tab' })),
    connectFirestoreEmulator: vi.fn(),
    getAuth: vi.fn(() => auth),
    connectAuthEmulator: vi.fn(),
    setPersistence: vi.fn(async () => undefined),
    signInWithEmailAndPassword: vi.fn(async () => ({ user: { uid: 'login-user' } })),
    createUserWithEmailAndPassword: vi.fn(async () => ({ user: { uid: 'signup-user' } })),
  }
})

vi.mock('firebase/app', () => ({
  initializeApp: firebase.initializeApp,
  getApps: firebase.getApps,
  deleteApp: firebase.deleteApp,
}))

vi.mock('firebase/firestore', () => ({
  initializeFirestore: firebase.initializeFirestore,
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
  projectId: 'project',
  storageBucket: 'bucket',
  messagingSenderId: 'sender',
  appId: 'app',
}

describe('Firebase auth persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    firebase.getApps.mockReturnValue([])
    firebase.setPersistence.mockResolvedValue(undefined)
    firebase.signInWithEmailAndPassword.mockResolvedValue({ user: { uid: 'login-user' } })
    firebase.createUserWithEmailAndPassword.mockResolvedValue({ user: { uid: 'signup-user' } })
  })

  it('initializes restored sessions with explicit local persistence', async () => {
    const { initFirebase } = await import('../src/sync/firebase')

    await expect(initFirebase(config)).resolves.toEqual({ db: firebase.db, auth: firebase.auth })

    expect(firebase.setPersistence).toHaveBeenCalledOnce()
    expect(firebase.setPersistence).toHaveBeenCalledWith(firebase.auth, firebase.local)
  })

  it('does not reinitialize a cached instance, but restores the local default after teardown', async () => {
    const { initFirebase, teardownFirebase } = await import('../src/sync/firebase')

    await initFirebase(config)
    await initFirebase(config)
    expect(firebase.initializeApp).toHaveBeenCalledOnce()
    expect(firebase.setPersistence).toHaveBeenCalledOnce()

    await teardownFirebase()
    await initFirebase(config)
    expect(firebase.initializeApp).toHaveBeenCalledTimes(2)
    expect(firebase.setPersistence).toHaveBeenCalledTimes(2)
    expect(firebase.setPersistence).toHaveBeenLastCalledWith(firebase.auth, firebase.local)
  })

  it('does not cache a partially initialized auth instance when the local default fails', async () => {
    const { initFirebase } = await import('../src/sync/firebase')
    firebase.setPersistence.mockRejectedValueOnce(new Error('persistence unavailable'))

    await expect(initFirebase(config)).rejects.toThrow('persistence unavailable')
    await expect(initFirebase(config)).resolves.toEqual({ db: firebase.db, auth: firebase.auth })

    expect(firebase.initializeApp).toHaveBeenCalledTimes(2)
    expect(firebase.deleteApp).toHaveBeenCalledWith(firebase.app)
    expect(firebase.setPersistence).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['local', true, firebase.local],
    ['session', false, firebase.session],
  ] as const)('sets %s persistence before signing in', async (_name, keepLoggedIn, expectedPersistence) => {
    const { fbSignIn } = await import('../src/sync/firebase')

    await fbSignIn(firebase.auth as never, 'parent@example.test', 'secret1', keepLoggedIn)

    expect(firebase.setPersistence).toHaveBeenCalledWith(firebase.auth, expectedPersistence)
    expect(firebase.signInWithEmailAndPassword).toHaveBeenCalledWith(
      firebase.auth,
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

    await fbSignUp(firebase.auth as never, 'parent@example.test', 'secret1', keepLoggedIn)

    expect(firebase.setPersistence).toHaveBeenCalledWith(firebase.auth, expectedPersistence)
    expect(firebase.createUserWithEmailAndPassword).toHaveBeenCalledWith(
      firebase.auth,
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
      fbSignIn(firebase.auth as never, 'parent@example.test', 'secret1', true),
    ).rejects.toThrow('persistence unavailable')
    expect(firebase.signInWithEmailAndPassword).not.toHaveBeenCalled()
  })
})
