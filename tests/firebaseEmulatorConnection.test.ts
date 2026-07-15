/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FirebaseEmulatorBridge } from '../shared/types'
import { getDigestFirebasePersistenceIdentity } from '../shared/firebasePersistence'
import { readFirebaseEmulatorBridge } from '../electron/firebaseEmulatorConfig'

const FIREBASE_REGISTRY = Symbol.for('baby-diary.firebase.service-registry.v1')

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
    getFirestore: vi.fn(() => db),
    terminate: vi.fn(async () => undefined),
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
}))

const bridge: FirebaseEmulatorBridge = {
  enabled: true,
  projectId: 'demo-baby-diary',
  firebaseConfig: {
    apiKey: 'demo-api-key',
    authDomain: 'demo-baby-diary.firebaseapp.com',
    projectId: 'demo-baby-diary',
    storageBucket: 'demo-baby-diary.appspot.com',
    messagingSenderId: '123456789',
    appId: '1:123456789:web:sync-e2e',
  },
  authHost: '127.0.0.1',
  authPort: 9099,
  firestoreHost: '127.0.0.1',
  firestorePort: 8080,
}

const demoConfig = bridge.enabled ? bridge.firebaseConfig : null
if (!demoConfig) throw new Error('test emulator bridge must be enabled')

const productionConfig = {
  apiKey: 'production-api-key',
  authDomain: 'baby-diary-jaei-2026.firebaseapp.com',
  projectId: 'baby-diary-jaei-2026',
  storageBucket: 'baby-diary-jaei-2026.firebasestorage.app',
  messagingSenderId: '406531612461',
  appId: '1:406531612461:web:aa43b832f0661feaccfda4',
}

let claimFirebasePersistence: ReturnType<typeof vi.fn>

function exposeBridge(value: FirebaseEmulatorBridge | null) {
  claimFirebasePersistence = vi.fn(async config => {
    const identity = getDigestFirebasePersistenceIdentity(config)
    return {
      version: 1,
      configIdentity: identity.configIdentity,
      appName: identity.appName,
    }
  })
  Object.defineProperty(window, 'babyDiary', {
    configurable: true,
    writable: true,
    value: {
      getFirebaseEmulator: vi.fn(async () => value),
      claimFirebasePersistence,
    },
  })
}

describe('Firebase emulator connection', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (globalThis as unknown as Record<PropertyKey, unknown>)[FIREBASE_REGISTRY]
    vi.clearAllMocks()
    firebase.getApps.mockReturnValue([])
    firebase.deleteApp.mockImplementation(async app => {
      for (const symbol of Object.getOwnPropertySymbols(app)) {
        delete (app as Record<symbol, unknown>)[symbol]
      }
    })
    firebase.terminate.mockResolvedValue(undefined)
    firebase.connectFirestoreEmulator.mockImplementation(() => undefined)
    firebase.connectAuthEmulator.mockImplementation(() => undefined)
    firebase.setPersistence.mockResolvedValue(undefined)
    for (const symbol of Object.getOwnPropertySymbols(firebase.app)) {
      delete (firebase.app as Record<symbol, unknown>)[symbol]
    }
    exposeBridge(bridge)
  })

  it('uses the main-owned demo config for persistence preflight and emulator initialization', async () => {
    const { initFirebase } = await import('../src/sync/firebase')

    await expect(initFirebase(productionConfig)).resolves.toEqual({ db: firebase.db, auth: firebase.auth })

    expect(claimFirebasePersistence).toHaveBeenCalledWith(demoConfig)
    expect(firebase.initializeApp).toHaveBeenCalledWith(demoConfig, expect.any(String))
    expect(firebase.initializeFirestore).toHaveBeenCalledWith(
      firebase.app,
      expect.objectContaining({ experimentalForceLongPolling: true }),
    )
    expect(firebase.connectFirestoreEmulator).toHaveBeenCalledWith(firebase.db, '127.0.0.1', 8080)
    expect(firebase.connectAuthEmulator).toHaveBeenCalledWith(
      firebase.auth,
      'http://127.0.0.1:9099',
      { disableWarnings: true },
    )
    expect(firebase.connectAuthEmulator.mock.invocationCallOrder[0]).toBeLessThan(
      firebase.connectFirestoreEmulator.mock.invocationCallOrder[0],
    )
    expect(firebase.setPersistence).not.toHaveBeenCalled()
  })

  it('does not connect emulators in an ordinary production renderer', async () => {
    exposeBridge(null)
    const { initFirebase } = await import('../src/sync/firebase')

    await initFirebase(productionConfig)

    expect(claimFirebasePersistence).toHaveBeenCalledWith(productionConfig)
    expect(firebase.initializeApp).toHaveBeenCalledWith(productionConfig, expect.any(String))
    expect(firebase.initializeFirestore).toHaveBeenCalledWith(
      firebase.app,
      expect.not.objectContaining({ experimentalForceLongPolling: true }),
    )
    expect(firebase.connectFirestoreEmulator).not.toHaveBeenCalled()
    expect(firebase.connectAuthEmulator).not.toHaveBeenCalled()
    expect(firebase.setPersistence).not.toHaveBeenCalled()
  })

  it('rejects an invalid requested bridge before creating a Firebase app', async () => {
    exposeBridge({ enabled: false, reason: 'emulator endpoint rejected' })
    const { initFirebase } = await import('../src/sync/firebase')

    await expect(initFirebase(demoConfig)).rejects.toThrow('emulator endpoint rejected')
    expect(claimFirebasePersistence).not.toHaveBeenCalled()
    expect(firebase.initializeApp).not.toHaveBeenCalled()
  })

  it('rejects a test profile missing emulator bindings before production Firebase initialization', async () => {
    exposeBridge(readFirebaseEmulatorBridge({
      BABYDIARY_TEST_USERDATA: 'isolated-test-profile',
    }))
    const { initFirebase } = await import('../src/sync/firebase')

    await expect(initFirebase({ ...demoConfig, projectId: 'baby-diary-jaei-2026' }))
      .rejects.toThrow(/requires the Firebase emulator/i)
    expect(firebase.initializeApp).not.toHaveBeenCalled()
    expect(firebase.initializeFirestore).not.toHaveBeenCalled()
    expect(firebase.getAuth).not.toHaveBeenCalled()
  })

  it('cleans up a partially initialized app when an emulator connector fails and can retry', async () => {
    const { initFirebase } = await import('../src/sync/firebase')
    firebase.connectFirestoreEmulator.mockImplementationOnce(() => {
      throw new Error('firestore emulator unavailable')
    })

    await expect(initFirebase(demoConfig)).rejects.toThrow('firestore emulator unavailable')
    expect(firebase.terminate).toHaveBeenCalledWith(firebase.db)
    expect(firebase.deleteApp).toHaveBeenCalledWith(firebase.app)
    expect(firebase.setPersistence).not.toHaveBeenCalled()

    await expect(initFirebase(demoConfig)).resolves.toEqual({ db: firebase.db, auth: firebase.auth })
    expect(firebase.initializeApp).toHaveBeenCalledTimes(2)
    expect(firebase.connectFirestoreEmulator).toHaveBeenCalledTimes(2)
    expect(firebase.setPersistence).not.toHaveBeenCalled()
  })

  it('connects once per stable service and reconnects only after completed cleanup', async () => {
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
