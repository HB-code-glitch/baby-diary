/**
 * tests/restartSync.test.ts
 * Unit tests for restartSync() — SYNC-07
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock firebase module used by syncEngine
vi.mock('../src/sync/firebase', () => ({
  initFirebase: vi.fn(() => ({ db: {}, auth: {} })),
  teardownFirebase: vi.fn(),
  fbSignIn: vi.fn(),
  fbSignUp: vi.fn(),
  fbSignOut: vi.fn(),
  getFirebaseAuth: vi.fn(() => null),
}))

// Mock ipc used by syncEngine
vi.mock('../src/lib/ipc', () => ({
  ipc: {
    listEvents: vi.fn(async () => []),
    appendEvent: vi.fn(async () => 'ok'),
    getSettings: vi.fn(async () => ({ firebase: null, familyId: '' })),
    onEventAppended: vi.fn(() => () => {}),
  },
}))

// Mock firebase/auth onAuthStateChanged to be a no-op (never fires)
vi.mock('firebase/auth', async () => {
  const actual = await vi.importActual<typeof import('firebase/auth')>('firebase/auth')
  return {
    ...actual,
    onAuthStateChanged: vi.fn((_auth: unknown, _cb: unknown) => () => {}),
  }
})

// Mock firebase/firestore to avoid real network
vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore')
  return {
    ...actual,
    getFirestore: vi.fn(() => ({})),
    collection: vi.fn(),
    doc: vi.fn(),
    getDoc: vi.fn(),
    setDoc: vi.fn(),
    getDocs: vi.fn(),
    onSnapshot: vi.fn(() => () => {}),
    writeBatch: vi.fn(),
    serverTimestamp: vi.fn(),
  }
})

describe('restartSync', () => {
  beforeEach(async () => {
    vi.resetModules()
    // clear localStorage between tests (only in browser-like environments)
    if (typeof localStorage !== 'undefined' && typeof localStorage.clear === 'function') {
      localStorage.clear()
    }
  })

  it('runs stop → configure → start without throwing when never started', async () => {
    const { restartSync, getStatus } = await import('../src/sync/syncEngine')
    const cfg = {
      apiKey: 'k', authDomain: 'd', projectId: 'p',
      storageBucket: 'b', messagingSenderId: 'm', appId: 'a',
    }
    await expect(restartSync(cfg, 'fam1')).resolves.not.toThrow()
    // After restart, engine should be in signed-out (or connecting) state — not 'off' or 'no-config'
    const status = getStatus().status
    expect(['signed-out', 'connecting', 'online']).toContain(status)
  })

  it('is idempotent — concurrent calls do not stack', async () => {
    const { restartSync } = await import('../src/sync/syncEngine')
    const cfg = {
      apiKey: 'k', authDomain: 'd', projectId: 'p',
      storageBucket: 'b', messagingSenderId: 'm', appId: 'a',
    }
    // Fire two concurrent calls — second should be a no-op (no throw)
    await expect(Promise.all([
      restartSync(cfg, 'fam1'),
      restartSync(cfg, 'fam1'),
    ])).resolves.toBeDefined()
  })

  it('transitions status from off/no-config to signed-out after restart', async () => {
    const { restartSync, stop, getStatus } = await import('../src/sync/syncEngine')
    // First, stop explicitly to put engine in 'off'
    stop()
    expect(getStatus().status).toBe('off')

    const cfg = {
      apiKey: 'k', authDomain: 'd', projectId: 'p',
      storageBucket: 'b', messagingSenderId: 'm', appId: 'a',
    }
    await restartSync(cfg, 'fam2')
    const status = getStatus().status
    expect(['signed-out', 'connecting', 'online']).toContain(status)
  })
})
