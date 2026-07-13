/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteApp, initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const FIREBASE_REGISTRY = Symbol.for('baby-diary.firebase.service-registry.v1')

const config = {
  apiKey: 'stable-key',
  authDomain: 'stable.example.test',
  projectId: 'stable-project',
  storageBucket: 'stable-bucket',
  messagingSenderId: '123456',
  appId: 'stable-app-id',
}

const createdNames: string[] = []

afterEach(async () => {
  const { getApps } = await import('firebase/app')
  await Promise.all(getApps()
    .filter(app => createdNames.includes(app.name))
    .map(app => deleteApp(app)))
  createdNames.length = 0
  delete (globalThis as unknown as Record<PropertyKey, unknown>)[FIREBASE_REGISTRY]
})

describe('stable Firebase SDK persistence identity', () => {
  it('matches the installed Auth and Firestore persistence-key inputs across module reloads', async () => {
    let firebaseModule = await import('../src/sync/firebase')
    const first = firebaseModule.getFirebasePersistenceIdentity(config)
    const app = initializeApp(config, first.appName)
    createdNames.push(app.name)
    const auth = getAuth(app)
    const db = getFirestore(app)

    expect(auth.name).toBe(first.appName)
    expect((db as unknown as { _persistenceKey: string })._persistenceKey).toBe(first.appName)
    expect(first.authUserKey).toBe(`firebase:authUser:${config.apiKey}:${auth.name}`)

    vi.resetModules()
    firebaseModule = await import('../src/sync/firebase')
    expect(firebaseModule.getFirebasePersistenceIdentity({ ...config })).toEqual(first)
  })

  it('gives config A and B distinct identities while A remains stable', async () => {
    const { getFirebasePersistenceIdentity } = await import('../src/sync/firebase')
    const a1 = getFirebasePersistenceIdentity(config)
    const b = getFirebasePersistenceIdentity({ ...config, projectId: 'other-project' })
    const a2 = getFirebasePersistenceIdentity({ ...config })

    expect(a1).toEqual(a2)
    expect(b.appName).not.toBe(a1.appName)
  })

  it('reuses one real installed-SDK app across module reset and deletes it on release', async () => {
    const { getApps } = await import('firebase/app')
    let firebaseModule = await import('../src/sync/firebase')
    const identity = firebaseModule.getFirebasePersistenceIdentity(config)
    createdNames.push(identity.appName)

    const first = await firebaseModule.initFirebase(config, 'real-sdk-a')
    expect(first).not.toBeNull()
    expect(getApps().filter(app => app.name === identity.appName)).toHaveLength(1)

    vi.resetModules()
    firebaseModule = await import('../src/sync/firebase')
    const second = await firebaseModule.initFirebase({ ...config }, 'real-sdk-b')
    expect(second?.db).toBe(first?.db)
    expect(second?.auth).toBe(first?.auth)
    expect(getApps().filter(app => app.name === identity.appName)).toHaveLength(1)

    await firebaseModule.teardownFirebase()
    expect(getApps().filter(app => app.name === identity.appName)).toHaveLength(0)
  })
})
