import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, DiaryEvent } from '../shared/types'

type Scenario = 'healthy' | 'permission-denied' | 'unavailable' | 'unauthenticated' | 'missing' | 'no-member'

const harness = vi.hoisted(() => ({
  scenario: 'healthy' as Scenario,
  cloudFamilyId: 'family-A',
  familyOverrides: {} as Record<string, Scenario>,
  ownershipFamilyId: undefined as string | undefined,
  legacyPhysicalPresent: false,
  settings: {
    baby: { name: '', birthdate: '' },
    profile: { uid: 'user-1', name: 'Parent', role: 'mom' as const },
    familyId: 'family-A',
    firebase: null,
  } as AppSettings,
  authCallbacks: [] as Array<(user: unknown) => void>,
  mergeSettings: vi.fn(),
  setDoc: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  reconcileBabyInfo: vi.fn(),
  snapshotCalls: [] as Array<{
    path: string
    next: (snapshot: unknown) => void
    error: (error: Error) => void
    active: boolean
  }>,
  legacyEvent: {
    id: 'legacy-unbound-A',
    type: 'formula',
    at: '2026-07-15T01:00:00.000Z',
    data: { ml: 60 },
    author: { uid: 'user-1', name: 'Parent', role: 'mom' },
    createdAt: '2026-07-15T01:00:00.000Z',
    updatedAt: '2026-07-15T01:00:00.000Z',
    rev: 1,
    deleted: false,
  } as DiaryEvent,
}))

vi.mock('../src/sync/firebase', () => ({
  preflightFirebasePersistence: vi.fn(async () => ({
    version: 1,
    configIdentity: 'test-config',
    appName: 'baby-diary-test',
  })),
  initFirebase: vi.fn(async () => ({ db: { name: 'db' }, auth: { name: 'auth' } })),
  teardownFirebase: vi.fn(async () => undefined),
  fbSignIn: vi.fn(),
  fbSignUp: vi.fn(),
  fbSignOut: vi.fn(async () => undefined),
  getFirebaseAuth: vi.fn(() => null),
}))

vi.mock('../src/lib/ipc', () => ({
  ipc: {
    getFirebaseEmulator: vi.fn(async () => null),
    listEvents: vi.fn(async () => []),
    listEventMutations: vi.fn(async (expectedFamilyId?: string) => {
      if (expectedFamilyId !== undefined && expectedFamilyId !== harness.settings.familyId) {
        throw new Error('EVENT_FAMILY_MISMATCH')
      }
      return harness.legacyPhysicalPresent && harness.ownershipFamilyId === expectedFamilyId
        ? [structuredClone(harness.legacyEvent)]
        : []
    }),
    appendEvent: vi.fn(async (_event: unknown, expectedFamilyId?: string) => (
      expectedFamilyId === undefined || expectedFamilyId === harness.settings.familyId ? 'ok' : 'error'
    )),
    confirmEventFamily: vi.fn(async (familyId: string, allowLegacyAdoption = true) => {
      if (familyId !== harness.settings.familyId) return { status: 'error' as const, adoptedCount: 0 }
      if (!allowLegacyAdoption) return { status: 'ok' as const, adoptedCount: 0 }
      if (harness.ownershipFamilyId && harness.ownershipFamilyId !== familyId) {
        return {
          status: 'different-family' as const,
          adoptionFamilyId: harness.ownershipFamilyId,
          adoptedCount: 0,
        }
      }
      harness.ownershipFamilyId = familyId
      return {
        status: 'ok' as const,
        adoptionFamilyId: familyId,
        adoptedCount: harness.legacyPhysicalPresent ? 1 : 0,
      }
    }),
    getSettings: vi.fn(async () => structuredClone(harness.settings)),
    mergeSettings: (...args: unknown[]) => harness.mergeSettings(...args),
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
  reconcileFamilyBabyInfo: (...args: unknown[]) => harness.reconcileBabyInfo(...args),
  setBabyInfoPersistenceObserver: vi.fn(),
}))

vi.mock('firebase/auth', async () => {
  const actual = await vi.importActual<typeof import('firebase/auth')>('firebase/auth')
  return {
    ...actual,
    onAuthStateChanged: vi.fn((_auth: unknown, callback: (user: unknown) => void) => {
      harness.authCallbacks.push(callback)
      return () => undefined
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
    getDocs: (...args: unknown[]) => harness.getDocs(...args),
    setDoc: (...args: unknown[]) => harness.setDoc(...args),
    updateDoc: vi.fn(async () => undefined),
    onSnapshot: vi.fn((ref: { path: string }, ...args: unknown[]) => {
      const registration = {
        path: ref.path,
        next: args[args.length - 2] as (snapshot: unknown) => void,
        error: args[args.length - 1] as (error: Error) => void,
        active: true,
      }
      harness.snapshotCalls.push(registration)
      return () => { registration.active = false }
    }),
    writeBatch: vi.fn(() => ({ set: vi.fn(), commit: vi.fn(async () => undefined) })),
    serverTimestamp: vi.fn(() => null),
  }
})

const config = {
  apiKey: 'key',
  authDomain: 'example.test',
  projectId: 'demo',
  storageBucket: 'bucket',
  messagingSenderId: 'sender',
  appId: 'app',
}

function familyData(scenario = harness.scenario) {
  return {
    name: 'Family',
    babyName: '',
    babyBirthdate: '',
    members: scenario === 'no-member'
      ? {}
      : { 'user-1': { name: 'Parent', role: 'mom' } },
    inviteCode: 'ABC234',
    createdAt: null,
  }
}

async function connect() {
  const engine = await import('../src/sync/syncEngine')
  await engine.configure(config, harness.settings.familyId)
  await engine.start()
  await vi.waitFor(() => expect(harness.authCallbacks).toHaveLength(1))
  harness.authCallbacks[0]({ uid: 'user-1', email: 'parent@example.test' })
  return engine
}

describe('non-destructive family identity reconciliation', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    vi.clearAllMocks()
    localStorage.clear()
    harness.scenario = 'healthy'
    harness.cloudFamilyId = 'family-A'
    harness.familyOverrides = {}
    harness.ownershipFamilyId = undefined
    harness.legacyPhysicalPresent = false
    harness.authCallbacks.length = 0
    harness.snapshotCalls.length = 0
    harness.settings = {
      baby: { name: '', birthdate: '' },
      profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
      familyId: 'family-A',
      firebase: null,
    }
    harness.mergeSettings.mockImplementation(async (partial: Partial<AppSettings>) => {
      harness.settings = { ...harness.settings, ...partial }
      return structuredClone(harness.settings)
    })
    harness.setDoc.mockResolvedValue(undefined)
    harness.getDoc.mockImplementation(async (ref: { path: string; id: string }) => {
      if (ref.path === 'users/user-1') {
        return {
          id: ref.id,
          exists: () => true,
          data: () => harness.cloudFamilyId ? { familyId: harness.cloudFamilyId } : {},
        }
      }
      if (ref.path.startsWith('families/')) {
        const familyId = ref.path.split('/')[1]
        const scenario = harness.familyOverrides[familyId]
          ?? (familyId === 'family-A' ? harness.scenario : 'healthy')
        if (scenario === 'permission-denied'
          || scenario === 'unavailable'
          || scenario === 'unauthenticated') {
          throw Object.assign(new Error(scenario), { code: scenario })
        }
        if (scenario === 'missing') {
          return { id: ref.id, exists: () => false, data: () => undefined }
        }
        return { id: ref.id, exists: () => true, data: () => familyData(scenario) }
      }
      return { id: ref.id, exists: () => false, data: () => undefined }
    })
    harness.getDocs.mockResolvedValue({ docs: [] })
    harness.reconcileBabyInfo.mockResolvedValue({
      pendingCount: 0,
      activePendingCount: 0,
      needsRetry: false,
      uploadFailures: 0,
      settings: structuredClone(harness.settings),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['permission-denied', 'unavailable', 'unauthenticated'] as const)(
    'preserves local and cloud identity when family access is uncertain: %s',
    async scenario => {
      harness.scenario = scenario
      const engine = await connect()
      await vi.waitFor(() => expect(engine.getStatus().detail).toBe(engine.DETAIL_FAMILY_ACCESS_UNCERTAIN))

      expect(harness.settings.familyId).toBe('family-A')
      expect(harness.mergeSettings).not.toHaveBeenCalledWith({ familyId: '' })
      expect(harness.setDoc).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: 'users/user-1' }),
        { familyId: '' },
        expect.anything(),
      )
    },
  )

  it('clears only local identity for an explicit not-found family document', async () => {
    harness.scenario = 'missing'
    const engine = await connect()
    await vi.waitFor(() => expect(engine.getStatus().detail).toBe(engine.DETAIL_FAMILY_GONE))

    expect(harness.mergeSettings).toHaveBeenCalledWith({ familyId: '' })
    expect(harness.setDoc).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'users/user-1' }),
      { familyId: '' },
      expect.anything(),
    )
  })

  it('treats a readable family without membership as confirmed gone', async () => {
    harness.scenario = 'no-member'
    const engine = await connect()
    await vi.waitFor(() => expect(engine.getStatus().detail).toBe(engine.DETAIL_FAMILY_GONE))

    expect(harness.mergeSettings).toHaveBeenCalledWith({ familyId: '' })
    expect(harness.setDoc).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'users/user-1' }),
      { familyId: '' },
      expect.anything(),
    )
  })

  it('pins local A before a verified cloud-B transition and never adopts A bytes into B after restart', async () => {
    harness.cloudFamilyId = 'family-B'
    harness.legacyPhysicalPresent = true
    const engine = await connect()
    await vi.waitFor(() => expect(engine.getStatus().status).toBe('online'))

    expect(harness.settings.familyId).toBe('family-B')
    expect(harness.ownershipFamilyId).toBe('family-A')
    expect(harness.setDoc.mock.calls.filter(([ref]) => (
      (ref as { path?: string }).path?.startsWith('families/family-B/events/')
    ))).toHaveLength(0)

    await engine.stop()
    harness.authCallbacks.length = 0
    harness.snapshotCalls.length = 0
    vi.resetModules()
    const restarted = await connect()
    await vi.waitFor(() => expect(restarted.getStatus().status).toBe('online'))

    expect(harness.settings.familyId).toBe('family-B')
    expect(harness.ownershipFamilyId).toBe('family-A')
    expect(harness.setDoc.mock.calls.filter(([ref]) => (
      (ref as { path?: string }).path?.startsWith('families/family-B/events/')
    ))).toHaveLength(0)
    const { ipc } = await import('../src/lib/ipc')
    expect(ipc.confirmEventFamily).toHaveBeenCalledWith('family-B', true)
  })

  it('pins local A before clearing a gone family so a later B join cannot adopt A bytes', async () => {
    harness.scenario = 'missing'
    harness.legacyPhysicalPresent = true
    const engine = await connect()
    await vi.waitFor(() => expect(engine.getStatus().detail).toBe(engine.DETAIL_FAMILY_GONE))

    expect(harness.settings.familyId).toBe('')
    expect(harness.ownershipFamilyId).toBe('family-A')

    await engine.stop()
    harness.cloudFamilyId = 'family-B'
    harness.authCallbacks.length = 0
    harness.snapshotCalls.length = 0
    vi.resetModules()
    const joined = await connect()
    await vi.waitFor(() => expect(joined.getStatus().status).toBe('online'))

    expect(harness.settings.familyId).toBe('family-B')
    expect(harness.ownershipFamilyId).toBe('family-A')
    expect(harness.setDoc.mock.calls.filter(([ref]) => (
      (ref as { path?: string }).path?.startsWith('families/family-B/events/')
    ))).toHaveLength(0)
  })

  it('validates a cloud-B candidate before changing local A and self-heals to verified A when B is stale', async () => {
    harness.cloudFamilyId = 'family-B'
    harness.familyOverrides['family-B'] = 'missing'
    harness.legacyPhysicalPresent = true
    const engine = await connect()
    await vi.waitFor(() => expect(engine.getStatus().status).toBe('online'))

    expect(harness.settings.familyId).toBe('family-A')
    expect(harness.mergeSettings).not.toHaveBeenCalledWith({ familyId: 'family-B' })
    expect(harness.setDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'users/user-1' }),
      { familyId: 'family-A' },
      { merge: true },
    )
    expect(harness.setDoc.mock.calls.filter(([ref]) => (
      (ref as { path?: string }).path?.startsWith('families/family-B/events/')
    ))).toHaveLength(0)
  })

  it('preserves local A and fails closed when both stale cloud B and local A membership are invalid', async () => {
    harness.cloudFamilyId = 'family-B'
    harness.familyOverrides['family-B'] = 'no-member'
    harness.scenario = 'missing'
    harness.legacyPhysicalPresent = true
    const engine = await connect()
    await vi.waitFor(() => expect(engine.getStatus().detail).toBe(engine.DETAIL_FAMILY_ACCESS_UNCERTAIN))

    expect(harness.settings.familyId).toBe('family-A')
    expect(harness.ownershipFamilyId).toBe('family-A')
    expect(harness.mergeSettings).not.toHaveBeenCalledWith({ familyId: 'family-B' })
    expect(harness.setDoc.mock.calls.filter(([ref]) => (
      (ref as { path?: string }).path?.startsWith('families/family-B/events/')
    ))).toHaveLength(0)
  })

  it('retries a zero-pending initial cloud read failure and reaches online', async () => {
    vi.useFakeTimers()
    harness.getDocs
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unavailable' }))
      .mockResolvedValue({ docs: [] })
    const engine = await connect()
    await vi.waitFor(() => expect(engine.getStatus().status).toBe('error'))
    expect(harness.getDocs).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_100)
    await vi.waitFor(() => expect(harness.getDocs.mock.calls.length).toBeGreaterThan(1))
    await vi.waitFor(() => expect(engine.getStatus().status).toBe('online'))
  })

  it('generation-safely reattaches all snapshots after a snapshot error', async () => {
    vi.useFakeTimers()
    const engine = await connect()
    await vi.waitFor(() => expect(engine.getStatus().status).toBe('online'))
    expect(harness.snapshotCalls.filter(item => item.active)).toHaveLength(3)

    const eventsSnapshot = harness.snapshotCalls.find(item => item.path.endsWith('/events'))!
    eventsSnapshot.error(Object.assign(new Error('offline'), { code: 'unavailable' }))
    expect(engine.getStatus().status).toBe('error')

    await vi.advanceTimersByTimeAsync(3_100)
    await vi.waitFor(() => expect(engine.getStatus().status).toBe('online'))
    expect(harness.snapshotCalls.filter(item => item.active)).toHaveLength(3)
    expect(harness.snapshotCalls.length).toBeGreaterThanOrEqual(6)
  })

  it('subscribes to the family projection and reconciles a pair-only old-client update', async () => {
    const engine = await connect()
    await vi.waitFor(() => expect(engine.getStatus().status).toBe('online'))
    const familySnapshot = harness.snapshotCalls.find(item => item.path === 'families/family-A')
    expect(familySnapshot).toBeDefined()
    const callsBefore = harness.reconcileBabyInfo.mock.calls.length

    familySnapshot!.next({
      exists: () => true,
      data: () => ({ ...familyData(), babyName: 'Old client edit', babyBirthdate: '2026-06-06' }),
    })
    await vi.waitFor(() => expect(harness.reconcileBabyInfo.mock.calls.length).toBeGreaterThan(callsBefore))
  })
})
