/**
 * tests/syncFamilyLifecycle.test.ts
 *
 * Proves createFamily/joinFamily (src/sync/syncEngine.ts) are atomic and
 * idempotent against a fake Firestore that models exactly the two
 * behaviors real Firestore has and syncEngine must handle correctly:
 *
 *  - A `writeBatch().commit()` either applies every queued op or none of
 *    them (no partial writes).
 *  - An error thrown from `commit()` can be definite (`permission-denied`,
 *    guaranteed not applied) or ambiguous (`unavailable` etc., applied
 *    status unknown to the client) — only ambiguous errors may be resolved
 *    by reading the destination documents back and accepting an already-
 *    applied commit instead of retrying.
 *
 * The fake never re-derives Firestore rules; the real rules are exercised
 * separately by tests/firestoreRulesEmulator.test.ts. This file exists to
 * prove syncEngine's own retry/read-back orchestration: exactly one batch
 * per successful attempt, no separate best-effort second write, bounded
 * collision retry that keeps one familyId, exact read-back acceptance,
 * restart recovery through users/{uid}.familyId, and join idempotency
 * across two different families.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../shared/types'
import { MAX_FAMILY_LIFECYCLE_ATTEMPTS } from '../shared/familyLifecycle'

// ────────────────────────────────────────────────────────────
// Fake Firestore: path-keyed store + batch commit outcome queue
// ────────────────────────────────────────────────────────────

type CommitOutcome =
  | { kind: 'success' }
  | { kind: 'error'; code: string; applied: boolean }

interface BatchOp {
  type: 'set' | 'update'
  path: string
  data: Record<string, unknown>
}

interface CommitCall {
  ops: BatchOp[]
}

const SERVER_TIMESTAMP_SENTINEL = { __sentinel: 'serverTimestamp' as const }

const harness = vi.hoisted(() => ({
  store: new Map<string, Record<string, unknown>>(),
  autoIdSeq: 0,
  timestampSeq: 0,
  commitQueue: [] as CommitOutcome[],
  commitCalls: [] as CommitCall[],
  inviteCodeQueue: [] as string[],
  authCallbacks: [] as Array<(user: unknown) => void>,
  setDocSpy: vi.fn(async () => undefined),
  updateDocSpy: vi.fn(async () => undefined),
  mergeSettings: vi.fn(),
  commitBabyInfo: vi.fn(async () => ({ ok: true })),
  settings: null as unknown as AppSettings,
}))

function resolveServerTimestamps(value: unknown): unknown {
  if (value === SERVER_TIMESTAMP_SENTINEL) {
    return { __fakeTimestamp: true, seq: ++harness.timestampSeq }
  }
  if (Array.isArray(value)) return value.map(resolveServerTimestamps)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveServerTimestamps(v)
    return out
  }
  return value
}

function setDotPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const dotIdx = key.indexOf('.')
  if (dotIdx < 0) {
    target[key] = value
    return
  }
  const top = key.slice(0, dotIdx)
  const rest = key.slice(dotIdx + 1)
  const existing = (target[top] && typeof target[top] === 'object') ? { ...(target[top] as Record<string, unknown>) } : {}
  existing[rest] = value
  target[top] = existing
}

function pathOf(parent: unknown, segments: string[]): string {
  const prefix = parent && typeof parent === 'object' && 'path' in parent
    ? `${(parent as { path: string }).path}/`
    : ''
  return `${prefix}${segments.join('/')}`
}

function fakeDoc(parent: unknown, ...segments: string[]) {
  if (segments.length === 0) {
    const id = `auto-${++harness.autoIdSeq}`
    const path = `${(parent as { path: string }).path}/${id}`
    return { path, id }
  }
  const path = pathOf(parent, segments)
  return { path, id: path.split('/').at(-1) as string }
}

function fakeCollection(parent: unknown, ...segments: string[]) {
  return { path: pathOf(parent, segments) }
}

async function fakeGetDoc(ref: { path: string; id: string }) {
  const data = harness.store.get(ref.path)
  return { id: ref.id, exists: () => data !== undefined, data: () => data }
}

function fakeWriteBatch() {
  const ops: BatchOp[] = []
  return {
    set: (ref: { path: string }, data: Record<string, unknown>) => {
      ops.push({ type: 'set', path: ref.path, data })
    },
    update: (ref: { path: string }, data: Record<string, unknown>) => {
      ops.push({ type: 'update', path: ref.path, data })
    },
    commit: async () => {
      harness.commitCalls.push({ ops: ops.map(op => ({ ...op })) })
      const outcome = harness.commitQueue.shift() ?? { kind: 'success' as const }
      const apply = () => {
        for (const op of ops) {
          if (op.type === 'set') {
            harness.store.set(op.path, resolveServerTimestamps(op.data) as Record<string, unknown>)
          } else {
            const existing = { ...(harness.store.get(op.path) ?? {}) }
            for (const [key, value] of Object.entries(op.data)) setDotPath(existing, key, resolveServerTimestamps(value))
            harness.store.set(op.path, existing)
          }
        }
      }
      if (outcome.kind === 'success') {
        apply()
        return
      }
      if (outcome.applied) apply()
      throw Object.assign(new Error(`fake commit error: ${outcome.code}`), { code: outcome.code })
    },
  }
}

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
    listEventMutations: vi.fn(async () => []),
    appendEvent: vi.fn(async () => 'ok'),
    confirmEventFamily: vi.fn(async (familyId: string) => ({
      status: 'ok' as const,
      adoptionFamilyId: familyId,
      adoptedCount: 0,
    })),
    getSettings: vi.fn(async () => structuredClone(harness.settings)),
    mergeSettings: (...args: unknown[]) => harness.mergeSettings(...args),
    saveSettings: vi.fn(async (settings: AppSettings) => settings),
    getBabyInfoSummary: vi.fn(async (familyId: string) => ({
      familyId,
      mutationCount: 0,
      pendingCount: 0,
      totalPendingCount: 0,
    })),
    commitBabyInfo: (...args: unknown[]) => harness.commitBabyInfo(...args),
  },
}))

vi.mock('../src/sync/babyInfoSync', () => ({
  makeBabyInfoDocId: vi.fn(() => 'baby-info'),
  parseCloudBabyInfoDocument: vi.fn(() => null),
  persistSettingsWithBabyInfoMutation: vi.fn(),
  reconcileFamilyBabyInfo: vi.fn(async () => ({
    pendingCount: 0,
    activePendingCount: 0,
    needsRetry: false,
    uploadFailures: 0,
    settings: structuredClone(harness.settings),
  })),
  setBabyInfoPersistenceObserver: vi.fn(),
}))

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn((_auth: unknown, callback: (user: unknown) => void) => {
    harness.authCallbacks.push(callback)
    return () => undefined
  }),
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(fakeCollection),
  doc: vi.fn(fakeDoc),
  query: vi.fn((ref: unknown) => ref),
  orderBy: vi.fn(() => ({})),
  documentId: vi.fn(() => '__name__'),
  startAfter: vi.fn(() => ({})),
  limit: vi.fn(() => ({})),
  getDoc: vi.fn(fakeGetDoc),
  setDoc: (...args: unknown[]) => harness.setDocSpy(...args),
  updateDoc: (...args: unknown[]) => harness.updateDocSpy(...args),
  getDocs: vi.fn(async () => ({ docs: [] })),
  onSnapshot: vi.fn(() => () => undefined),
  writeBatch: vi.fn(fakeWriteBatch),
  serverTimestamp: vi.fn(() => SERVER_TIMESTAMP_SENTINEL),
}))

vi.mock('../shared/inviteCode', () => ({
  INVITE_CODE_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  INVITE_CODE_LENGTH: 6,
  generateInviteCode: vi.fn(() => {
    const next = harness.inviteCodeQueue.shift()
    if (!next) throw new Error('test inviteCodeQueue exhausted')
    return next
  }),
}))

const config = {
  apiKey: 'key',
  authDomain: 'example.test',
  projectId: 'demo',
  storageBucket: 'bucket',
  messagingSenderId: 'sender',
  appId: 'app',
}

async function connect(uid: string, email: string) {
  const engine = await import('../src/sync/syncEngine')
  await engine.configure(config, '')
  await engine.start()
  await vi.waitFor(() => expect(harness.authCallbacks).toHaveLength(1))
  harness.authCallbacks[0]({ uid, email })
  return engine
}

function seedInvite(code: string, familyId: string, createdAt: unknown = { __fakeTimestamp: true, seq: -1 }) {
  harness.store.set(`invites/${code}`, { familyId, code_check: code, createdAt })
}

function seedFamily(
  familyId: string,
  data: {
    name?: string
    babyName: string
    babyBirthdate: string
    members: Record<string, { name: string; role: 'dad' | 'mom' }>
    inviteCode: string
  },
) {
  harness.store.set(`families/${familyId}`, {
    name: data.name ?? 'Family',
    babyName: data.babyName,
    babyBirthdate: data.babyBirthdate,
    members: data.members,
    inviteCode: data.inviteCode,
    createdAt: { __fakeTimestamp: true, seq: -1 },
  })
}

function seedUser(uid: string, familyId: string) {
  harness.store.set(`users/${uid}`, { familyId })
}

function pathsOf(call: CommitCall): string[] {
  return call.ops.map(op => op.path)
}

describe('createFamily / joinFamily atomic lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    vi.clearAllMocks()
    localStorage.clear()
    harness.store.clear()
    harness.autoIdSeq = 0
    harness.timestampSeq = 0
    harness.commitQueue = []
    harness.commitCalls = []
    harness.inviteCodeQueue = []
    harness.authCallbacks.length = 0
    harness.settings = {
      baby: { name: '', birthdate: '' },
      profile: { uid: 'test-uid', name: 'Parent', role: 'mom' },
      familyId: '',
      firebase: null,
    }
    harness.mergeSettings.mockImplementation(async (partial: Partial<AppSettings>) => {
      harness.settings = { ...harness.settings, ...partial }
      return structuredClone(harness.settings)
    })
    harness.commitBabyInfo.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ──────────────────────────────────────────────────────────
  // createFamily
  // ──────────────────────────────────────────────────────────

  describe('createFamily', () => {
    it('writes exactly one batch containing families/{id}, invites/{code}, users/{uid} — no separate write', async () => {
      harness.inviteCodeQueue = ['AAAAAA']
      const engine = await connect('uid-create-1', 'a@example.test')

      const result = await engine.createFamily(
        { babyName: 'Baby', babyBirthdate: '2026-01-01' },
        { uid: 'ignored', name: 'Mom', role: 'mom' },
      )

      expect(result).toEqual({ familyId: expect.stringMatching(/^auto-\d+$/), inviteCode: 'AAAAAA' })
      expect(harness.commitCalls).toHaveLength(1)
      const paths = pathsOf(harness.commitCalls[0]).sort()
      expect(paths).toEqual([
        `families/${result.familyId}`,
        'invites/AAAAAA',
        'users/uid-create-1',
      ].sort())
      expect(harness.commitCalls[0].ops).toHaveLength(3)
      // No best-effort second write outside the batch.
      expect(harness.setDocSpy).not.toHaveBeenCalled()
    })

    it('collision retry keeps the SAME familyId across attempts and returns the winning code', async () => {
      seedInvite('AAAAAA', 'someone-elses-family')
      harness.inviteCodeQueue = ['AAAAAA', 'BBBBBB']
      harness.commitQueue = [
        { kind: 'error', code: 'permission-denied', applied: false },
        { kind: 'success' },
      ]
      const engine = await connect('uid-create-2', 'b@example.test')

      const result = await engine.createFamily(
        { babyName: 'Baby', babyBirthdate: '2026-01-01' },
        { uid: 'ignored', name: 'Dad', role: 'dad' },
      )

      expect(result.inviteCode).toBe('BBBBBB')
      expect(harness.commitCalls).toHaveLength(2)
      const familyIdAttempt1 = harness.commitCalls[0].ops.find(op => op.path.startsWith('families/'))!.path
      const familyIdAttempt2 = harness.commitCalls[1].ops.find(op => op.path.startsWith('families/'))!.path
      expect(familyIdAttempt1).toBe(familyIdAttempt2)
      expect(harness.store.has('invites/BBBBBB')).toBe(true)
    })

    it('bounds collision retry attempts and surfaces the last error', async () => {
      const codes = Array.from({ length: MAX_FAMILY_LIFECYCLE_ATTEMPTS }, (_, i) => `AAAAA${String.fromCharCode(65 + i)}`)
      for (const code of codes) seedInvite(code, 'someone-elses-family')
      harness.inviteCodeQueue = [...codes]
      harness.commitQueue = codes.map(() => ({ kind: 'error' as const, code: 'permission-denied', applied: false }))
      const engine = await connect('uid-create-3', 'c@example.test')

      await expect(engine.createFamily(
        { babyName: 'Baby', babyBirthdate: '2026-01-01' },
        { uid: 'ignored', name: 'Mom', role: 'mom' },
      )).rejects.toThrow()
      expect(harness.commitCalls).toHaveLength(MAX_FAMILY_LIFECYCLE_ATTEMPTS)
    })

    it('accepts an ambiguous commit error as success once read-back proves it landed', async () => {
      harness.inviteCodeQueue = ['CCCCCC']
      harness.commitQueue = [{ kind: 'error', code: 'unavailable', applied: true }]
      const engine = await connect('uid-create-4', 'd@example.test')

      const result = await engine.createFamily(
        { babyName: 'Baby', babyBirthdate: '2026-01-01' },
        { uid: 'ignored', name: 'Mom', role: 'mom' },
      )

      expect(result.inviteCode).toBe('CCCCCC')
      // Exactly one commit attempt — no retry once the read-back verified success.
      expect(harness.commitCalls).toHaveLength(1)
    })

    it('retries with a new code when an ambiguous error did NOT actually apply, leaving no partial trace', async () => {
      harness.inviteCodeQueue = ['DDDDDD', 'EEEEEE']
      harness.commitQueue = [
        { kind: 'error', code: 'unavailable', applied: false },
        { kind: 'success' },
      ]
      const engine = await connect('uid-create-5', 'e@example.test')

      const result = await engine.createFamily(
        { babyName: 'Baby', babyBirthdate: '2026-01-01' },
        { uid: 'ignored', name: 'Mom', role: 'mom' },
      )

      expect(result.inviteCode).toBe('EEEEEE')
      expect(harness.commitCalls).toHaveLength(2)
      expect(harness.store.has('invites/DDDDDD')).toBe(false)
    })

    it('rethrows a definite permission-denied that is not an invite collision without retrying', async () => {
      harness.inviteCodeQueue = ['FFFFFF']
      harness.commitQueue = [{ kind: 'error', code: 'permission-denied', applied: false }]
      const engine = await connect('uid-create-6', 'f@example.test')

      await expect(engine.createFamily(
        { babyName: 'Baby', babyBirthdate: '2026-01-01' },
        { uid: 'ignored', name: 'Mom', role: 'mom' },
      )).rejects.toThrow()
      expect(harness.commitCalls).toHaveLength(1)
    })

    it('recovers the existing family through users/{uid}.familyId across a restart without writing a duplicate', async () => {
      seedUser('uid-restart', 'family-prior')
      seedInvite('ZZZZZZ', 'family-prior')
      seedFamily('family-prior', {
        babyName: 'Existing baby',
        babyBirthdate: '2025-05-05',
        members: { 'uid-restart': { name: 'Parent', role: 'mom' } },
        inviteCode: 'ZZZZZZ',
      })
      const engine = await connect('uid-restart', 'restart@example.test')

      const result = await engine.createFamily(
        { babyName: 'New attempted baby', babyBirthdate: '2026-09-09' },
        { uid: 'ignored', name: 'Parent', role: 'mom' },
      )

      expect(result).toEqual({ familyId: 'family-prior', inviteCode: 'ZZZZZZ' })
      expect(harness.commitCalls).toHaveLength(0)
      expect(engine.getStatus().inviteCode).toBe('ZZZZZZ')
    })
  })

  // ──────────────────────────────────────────────────────────
  // joinFamily
  // ──────────────────────────────────────────────────────────

  describe('joinFamily', () => {
    it('writes exactly one batch containing joinProofs/{uid}/capabilities/{code}, families/{id}.members.{uid}, users/{uid}', async () => {
      seedInvite('JAAAAA', 'family-x')
      seedFamily('family-x', {
        babyName: 'Baby X', babyBirthdate: '2026-02-02', members: {}, inviteCode: 'JAAAAA',
      })
      const engine = await connect('uid-join-1', 'g@example.test')

      const result = await engine.joinFamily('jaaaaa', { uid: 'ignored', name: 'Dad', role: 'dad' })

      expect(result).toEqual({ familyId: 'family-x', babyName: 'Baby X', babyBirthdate: '2026-02-02' })
      expect(harness.commitCalls).toHaveLength(1)
      const call = harness.commitCalls[0]
      expect(pathsOf(call).sort()).toEqual([
        'families/family-x',
        'joinProofs/uid-join-1/capabilities/JAAAAA',
        'users/uid-join-1',
      ].sort())
      const familyOp = call.ops.find(op => op.path === 'families/family-x')!
      expect(Object.keys(familyOp.data)).toEqual(['members.uid-join-1'])
      expect(familyOp.data['members.uid-join-1']).toEqual({ name: 'Dad', role: 'dad' })
      const proofOp = call.ops.find(op => op.path.startsWith('joinProofs/'))!
      expect(proofOp.data).toEqual({ uid: 'uid-join-1', familyId: 'family-x', inviteCode: 'JAAAAA' })
      const userOp = call.ops.find(op => op.path === 'users/uid-join-1')!
      expect(userOp.data).toEqual({ familyId: 'family-x' })
    })

    it('retries idempotently after an ambiguous error and again on an explicit repeat call', async () => {
      seedInvite('JBBBBB', 'family-y')
      seedFamily('family-y', {
        babyName: 'Baby Y', babyBirthdate: '2026-03-03', members: {}, inviteCode: 'JBBBBB',
      })
      harness.commitQueue = [{ kind: 'error', code: 'unavailable', applied: false }, { kind: 'success' }]
      const engine = await connect('uid-join-2', 'h@example.test')

      const first = await engine.joinFamily('JBBBBB', { uid: 'ignored', name: 'Mom', role: 'mom' })
      expect(first.familyId).toBe('family-y')
      expect(harness.commitCalls).toHaveLength(2)

      const second = await engine.joinFamily('JBBBBB', { uid: 'ignored', name: 'Mom', role: 'mom' })
      expect(second.familyId).toBe('family-y')
      expect(harness.commitCalls).toHaveLength(3)
      expect((harness.store.get('families/family-y') as { members: Record<string, unknown> }).members).toEqual({
        'uid-join-2': { name: 'Mom', role: 'mom' },
      })
    })

    it('joining a second family later does not mutate the first', async () => {
      seedInvite('JCCCCC', 'family-first')
      seedFamily('family-first', {
        babyName: 'First baby', babyBirthdate: '2026-04-04', members: {}, inviteCode: 'JCCCCC',
      })
      seedInvite('JDDDDD', 'family-second')
      seedFamily('family-second', {
        babyName: 'Second baby', babyBirthdate: '2026-05-05', members: {}, inviteCode: 'JDDDDD',
      })
      const engine = await connect('uid-join-3', 'i@example.test')

      await engine.joinFamily('JCCCCC', { uid: 'ignored', name: 'Mom', role: 'mom' })
      const firstFamilySnapshot = structuredClone(harness.store.get('families/family-first'))

      const result = await engine.joinFamily('JDDDDD', { uid: 'ignored', name: 'Mom', role: 'mom' })

      expect(result.familyId).toBe('family-second')
      expect(harness.store.get('families/family-first')).toEqual(firstFamilySnapshot)
      expect((harness.store.get('families/family-second') as { members: Record<string, unknown> }).members).toEqual({
        'uid-join-3': { name: 'Mom', role: 'mom' },
      })
    })

    it('throws immediately for an unknown invite code without any batch commit', async () => {
      const engine = await connect('uid-join-4', 'j@example.test')

      await expect(engine.joinFamily('NOPE99', { uid: 'ignored', name: 'Mom', role: 'mom' }))
        .rejects.toThrow(/invite code not found/i)
      expect(harness.commitCalls).toHaveLength(0)
    })

    it('rethrows a definite permission-denied without retrying', async () => {
      seedInvite('JEEEEE', 'family-z')
      seedFamily('family-z', {
        babyName: 'Baby Z', babyBirthdate: '2026-06-06', members: {}, inviteCode: 'JEEEEE',
      })
      harness.commitQueue = [{ kind: 'error', code: 'permission-denied', applied: false }]
      const engine = await connect('uid-join-5', 'k@example.test')

      await expect(engine.joinFamily('JEEEEE', { uid: 'ignored', name: 'Mom', role: 'mom' })).rejects.toThrow()
      expect(harness.commitCalls).toHaveLength(1)
    })
  })
})
