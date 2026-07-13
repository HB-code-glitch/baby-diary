import { beforeEach, describe, expect, it, vi } from 'vitest'

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
})
