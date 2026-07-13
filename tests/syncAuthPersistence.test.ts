import { beforeEach, describe, expect, it, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

const firebase = vi.hoisted(() => ({
  auth: { name: 'auth' },
  db: { name: 'db' },
  initFirebase: vi.fn(),
  teardownFirebase: vi.fn(async () => undefined),
  fbSignIn: vi.fn(),
  fbSignUp: vi.fn(),
  fbSignOut: vi.fn(),
  getFirebaseAuth: vi.fn(() => null),
}))

vi.mock('../src/sync/firebase', () => firebase)

vi.mock('../src/lib/ipc', () => ({
  ipc: {
    listEvents: vi.fn(async () => []),
    appendEvent: vi.fn(async () => 'ok'),
    getSettings: vi.fn(async () => ({ firebase: null, familyId: '' })),
    onEventAppended: vi.fn(() => () => undefined),
  },
}))

const config = {
  apiKey: 'key',
  authDomain: 'example.test',
  projectId: 'project',
  storageBucket: 'bucket',
  messagingSenderId: 'sender',
  appId: 'app',
}

describe('sync auth persistence forwarding', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    firebase.initFirebase.mockResolvedValue({ auth: firebase.auth, db: firebase.db })
    firebase.fbSignIn.mockResolvedValue({ user: { uid: 'login-user' } })
    firebase.fbSignUp.mockResolvedValue({ user: { uid: 'signup-user' } })
  })

  it.each([true, false])('forwards keepLoggedIn=%s through signIn', async keepLoggedIn => {
    const engine = await import('../src/sync/syncEngine')
    await engine.configure(config, '')

    await expect(engine.signIn('parent@example.test', 'secret1', keepLoggedIn)).resolves.toMatchObject({
      uid: 'login-user',
    })
    expect(firebase.fbSignIn).toHaveBeenCalledWith(
      firebase.auth,
      'parent@example.test',
      'secret1',
      keepLoggedIn,
    )
  })

  it.each([true, false])('forwards keepLoggedIn=%s through signUp', async keepLoggedIn => {
    const engine = await import('../src/sync/syncEngine')
    await engine.configure(config, '')

    await expect(engine.signUp('parent@example.test', 'secret1', keepLoggedIn)).resolves.toMatchObject({
      uid: 'signup-user',
    })
    expect(firebase.fbSignUp).toHaveBeenCalledWith(
      firebase.auth,
      'parent@example.test',
      'secret1',
      keepLoggedIn,
    )
  })

  it('does not let a persisted user reappear when sign-out claims held initialization', async () => {
    const held = deferred<{ auth: { currentUser: unknown }; db: object }>()
    firebase.initFirebase.mockReturnValueOnce(held.promise)
    firebase.fbSignOut.mockImplementationOnce(async (auth: { currentUser: unknown }) => {
      auth.currentUser = null
    })
    const engine = await import('../src/sync/syncEngine')
    const configuring = engine.configure(config, '')
    await vi.waitFor(() => expect(firebase.initFirebase).toHaveBeenCalledTimes(1))
    const signingOut = engine.signOutSync()
    const auth = { currentUser: { uid: 'persisted-user' } }

    held.resolve({ auth, db: firebase.db })
    await Promise.all([configuring, signingOut])

    expect(firebase.fbSignOut).toHaveBeenCalledTimes(1)
    expect(firebase.fbSignOut).toHaveBeenCalledWith(auth)
    expect(auth.currentUser).toBeNull()
    expect(engine.getStatus().status).toBe('signed-out')
  })
})
