import { beforeEach, describe, expect, it, vi } from 'vitest'

const firebase = vi.hoisted(() => {
  const app = { name: 'baby-diary' }
  const auth: { name: string; currentUser: { uid: string } | null } = {
    name: 'auth',
    currentUser: null,
  }
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
    firebase.auth.currentUser = null
    firebase.setPersistence.mockResolvedValue(undefined)
    firebase.signInWithEmailAndPassword.mockResolvedValue({ user: { uid: 'login-user' } })
    firebase.createUserWithEmailAndPassword.mockResolvedValue({ user: { uid: 'signup-user' } })
  })

  it('preserves a restored session choice during renderer reload', async () => {
    const { initFirebase } = await import('../src/sync/firebase')
    firebase.auth.currentUser = { uid: 'session-user' }

    await expect(initFirebase(config)).resolves.toEqual({ db: firebase.db, auth: firebase.auth })

    expect(firebase.getAuth).toHaveBeenCalledWith(firebase.app)
    expect(firebase.auth.currentUser).toEqual({ uid: 'session-user' })
    expect(firebase.setPersistence).not.toHaveBeenCalled()
  })

  it('does not choose persistence while initializing or reinitializing Firebase', async () => {
    const { initFirebase, teardownFirebase } = await import('../src/sync/firebase')

    await initFirebase(config)
    await initFirebase(config)
    expect(firebase.initializeApp).toHaveBeenCalledOnce()
    expect(firebase.setPersistence).not.toHaveBeenCalled()

    await teardownFirebase()
    await initFirebase(config)
    expect(firebase.initializeApp).toHaveBeenCalledTimes(2)
    expect(firebase.setPersistence).not.toHaveBeenCalled()
  })

  it('does not let a held old teardown clear a newer owned Firebase instance', async () => {
    let finishDelete!: () => void
    const heldDelete = new Promise<void>(resolve => { finishDelete = resolve })
    firebase.deleteApp.mockReturnValueOnce(heldDelete)
    const { getFirebaseAuth, initFirebase, teardownFirebase } = await import('../src/sync/firebase')

    await initFirebase(config, 'owner-a')
    const tearingDown = teardownFirebase()
    await initFirebase(config, 'owner-b')
    expect(getFirebaseAuth()).toBe(firebase.auth)

    finishDelete()
    await tearingDown
    expect(getFirebaseAuth()).toBe(firebase.auth)
  })

  it('keeps omitted keepLoggedIn as a local-persistence sign-in', async () => {
    const { fbSignIn } = await import('../src/sync/firebase')

    await fbSignIn(firebase.auth as never, 'parent@example.test', 'secret1')

    expect(firebase.setPersistence).toHaveBeenCalledWith(firebase.auth, firebase.local)
    expect(firebase.signInWithEmailAndPassword).toHaveBeenCalledOnce()
  })

  it('keeps omitted keepLoggedIn as a local-persistence sign-up', async () => {
    const { fbSignUp } = await import('../src/sync/firebase')

    await fbSignUp(firebase.auth as never, 'parent@example.test', 'secret1')

    expect(firebase.setPersistence).toHaveBeenCalledWith(firebase.auth, firebase.local)
    expect(firebase.createUserWithEmailAndPassword).toHaveBeenCalledOnce()
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
