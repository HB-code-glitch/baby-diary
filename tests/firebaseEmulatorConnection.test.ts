/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FirebaseEmulatorBridge } from '../shared/types'

const firebase = vi.hoisted(() => {
  const app = { name: 'baby-diary' }
  const auth = { name: 'auth' }
  const db = { name: 'db' }
  const local = { type: 'LOCAL' }

  return {
    app,
    auth,
    db,
    local,
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
}))

const bridge: FirebaseEmulatorBridge = {
  enabled: true,
  projectId: 'demo-baby-diary',
  authHost: '127.0.0.1',
  authPort: 9099,
  firestoreHost: '127.0.0.1',
  firestorePort: 8080,
}

const demoConfig = {
  apiKey: 'demo-api-key',
  authDomain: 'demo-baby-diary.firebaseapp.com',
  projectId: 'demo-baby-diary',
  storageBucket: 'demo-baby-diary.appspot.com',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:sync-e2e',
}

function exposeBridge(value: FirebaseEmulatorBridge | null) {
  Object.defineProperty(window, 'babyDiary', {
    configurable: true,
    writable: true,
    value: {
      getFirebaseEmulator: vi.fn(async () => value),
    },
  })
}

describe('Firebase emulator connection', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    firebase.getApps.mockReturnValue([])
    firebase.connectFirestoreEmulator.mockImplementation(() => undefined)
    firebase.connectAuthEmulator.mockImplementation(() => undefined)
    firebase.setPersistence.mockResolvedValue(undefined)
    exposeBridge(bridge)
  })

  it('connects Auth and Firestore emulators before persistence or credential work', async () => {
    const { initFirebase } = await import('../src/sync/firebase')

    await expect(initFirebase(demoConfig)).resolves.toEqual({ db: firebase.db, auth: firebase.auth })

    expect(firebase.connectFirestoreEmulator).toHaveBeenCalledWith(firebase.db, '127.0.0.1', 8080)
    expect(firebase.connectAuthEmulator).toHaveBeenCalledWith(
      firebase.auth,
      'http://127.0.0.1:9099',
      { disableWarnings: true },
    )
    expect(firebase.connectFirestoreEmulator.mock.invocationCallOrder[0]).toBeLessThan(
      firebase.setPersistence.mock.invocationCallOrder[0],
    )
    expect(firebase.connectAuthEmulator.mock.invocationCallOrder[0]).toBeLessThan(
      firebase.setPersistence.mock.invocationCallOrder[0],
    )
  })

  it('does not connect emulators in an ordinary production renderer', async () => {
    exposeBridge(null)
    const { initFirebase } = await import('../src/sync/firebase')

    await initFirebase({ ...demoConfig, projectId: 'production-project' })

    expect(firebase.connectFirestoreEmulator).not.toHaveBeenCalled()
    expect(firebase.connectAuthEmulator).not.toHaveBeenCalled()
    expect(firebase.setPersistence).toHaveBeenCalledWith(firebase.auth, firebase.local)
  })

  it('rejects an invalid requested bridge before creating a Firebase app', async () => {
    exposeBridge({ enabled: false, reason: 'emulator endpoint rejected' })
    const { initFirebase } = await import('../src/sync/firebase')

    await expect(initFirebase(demoConfig)).rejects.toThrow('emulator endpoint rejected')
    expect(firebase.initializeApp).not.toHaveBeenCalled()
  })

  it('rejects a non-demo Firebase config before creating a Firebase app', async () => {
    const { initFirebase } = await import('../src/sync/firebase')

    await expect(initFirebase({ ...demoConfig, projectId: 'baby-diary-jaei-2026' })).rejects.toThrow(
      'demo-baby-diary',
    )
    expect(firebase.initializeApp).not.toHaveBeenCalled()
  })

  it('cleans up a partially initialized app when an emulator connector fails and can retry', async () => {
    const { initFirebase } = await import('../src/sync/firebase')
    firebase.connectFirestoreEmulator.mockImplementationOnce(() => {
      throw new Error('firestore emulator unavailable')
    })

    await expect(initFirebase(demoConfig)).rejects.toThrow('firestore emulator unavailable')
    expect(firebase.deleteApp).toHaveBeenCalledWith(firebase.app)
    expect(firebase.setPersistence).not.toHaveBeenCalled()

    await expect(initFirebase(demoConfig)).resolves.toEqual({ db: firebase.db, auth: firebase.auth })
    expect(firebase.initializeApp).toHaveBeenCalledTimes(2)
    expect(firebase.connectFirestoreEmulator).toHaveBeenCalledTimes(2)
    expect(firebase.setPersistence).toHaveBeenCalledOnce()
  })

  it('connects each emulator once per app lifecycle', async () => {
    const { initFirebase, teardownFirebase } = await import('../src/sync/firebase')

    await initFirebase(demoConfig)
    await initFirebase(demoConfig)
    expect(firebase.connectAuthEmulator).toHaveBeenCalledOnce()
    expect(firebase.connectFirestoreEmulator).toHaveBeenCalledOnce()

    await teardownFirebase()
    await initFirebase(demoConfig)
    expect(firebase.connectAuthEmulator).toHaveBeenCalledTimes(2)
    expect(firebase.connectFirestoreEmulator).toHaveBeenCalledTimes(2)
  })
})
