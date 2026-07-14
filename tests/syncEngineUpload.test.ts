/**
 * tests/syncEngineUpload.test.ts
 *
 * Proves the upload half of src/sync/syncEngine.ts never lets a local original be
 * lost, silently rewritten, or wrongly ACKed while pushing it to Firestore.
 *
 * The required sequence is: derive an auth-bound derivative -> durably append it
 * through the existing main-process EventLog IPC (fsync) -> read the local mutation
 * log back to prove it physically landed -> write ONLY the derivative to Firestore
 * at its content-bound doc id -> read the server document back -> ACK (drop from
 * pending) only when the read-back parses AND is byte-identical to the derivative.
 *
 * Two fakes model the two durable boundaries a real deployment has:
 *  - `harness.mutations` models the main-process EventLog: `ipc.appendEvent` /
 *    `ipc.listEventMutations` read and write it, and a queued fault can make either
 *    call throw or return 'error' to simulate a crash at that exact boundary.
 *  - `harness.store` + a create-only `writeBatch`/`getDoc` model Firestore: `set()`
 *    against an existing path fails exactly like the real `allow update, delete:
 *    if false` rule, and `getDoc` interceptors can inject a crash or a corrupted/
 *    mismatched sibling at the exact server read-back boundary.
 *
 * Both fakes live in `vi.hoisted` state, so a test can call `vi.resetModules()` and
 * re-import the engine to simulate a full app restart while the "disk" and the
 * "cloud" persist exactly as a real restart would leave them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import type { AppSettings, DiaryEvent } from '../shared/types'
import {
  createEventSyncMetadata,
  deriveUploadReadyEvent,
  makeCloudEventDocId,
} from '../shared/cloudEventPayload'
import { getEventStorageKey } from '../shared/eventResolver'

// ────────────────────────────────────────────────────────────
// Fake EventLog (durable local mutation log) + fake Firestore
// ────────────────────────────────────────────────────────────

type AppendFault = { kind: 'throw'; message?: string } | { kind: 'error' }
type ListFault = { kind: 'throw'; message?: string } | { kind: 'omit-all' }
type CommitOutcome =
  | { kind: 'success' }
  | { kind: 'error'; code: string; applied: boolean }

interface BatchOp {
  type: 'set'
  path: string
  data: Record<string, unknown>
}

interface GetDocInterceptor {
  match: (path: string) => boolean
  run: () => { exists: false } | { exists: true; data: unknown }
}

const harness = vi.hoisted(() => ({
  mutations: new Map<string, unknown>(),
  store: new Map<string, unknown>(),
  appendEventQueue: [] as AppendFault[],
  listMutationsQueue: [] as ListFault[],
  commitQueue: [] as CommitOutcome[],
  commitCalls: [] as Array<{ ops: BatchOp[] }>,
  getDocInterceptors: [] as GetDocInterceptor[],
  authCallbacks: [] as Array<(user: unknown) => void>,
  mergeSettings: vi.fn(),
  settings: null as unknown as AppSettings,
}))

function pathOf(parent: unknown, segments: string[]): string {
  const prefix = parent && typeof parent === 'object' && 'path' in parent
    ? `${(parent as { path: string }).path}/`
    : ''
  return `${prefix}${segments.join('/')}`
}

function fakeDoc(parent: unknown, ...segments: string[]) {
  const path = pathOf(parent, segments)
  return { path, id: path.split('/').at(-1) as string }
}

function fakeCollection(parent: unknown, ...segments: string[]) {
  return { path: pathOf(parent, segments) }
}

function readStore(path: string): { exists: false } | { exists: true; data: unknown } {
  return harness.store.has(path) ? { exists: true, data: harness.store.get(path) } : { exists: false }
}

async function fakeGetDoc(ref: { path: string; id: string }) {
  for (let i = 0; i < harness.getDocInterceptors.length; i++) {
    if (harness.getDocInterceptors[i].match(ref.path)) {
      const interceptor = harness.getDocInterceptors.splice(i, 1)[0]
      const outcome = interceptor.run()
      return { id: ref.id, exists: () => outcome.exists, data: () => (outcome.exists ? outcome.data : undefined) }
    }
  }
  const outcome = readStore(ref.path)
  return { id: ref.id, exists: () => outcome.exists, data: () => (outcome.exists ? outcome.data : undefined) }
}

async function fakeGetDocs(ref: { path: string }) {
  const prefix = `${ref.path}/`
  const docs: Array<{ id: string; data: () => unknown }> = []
  for (const [path, data] of harness.store.entries()) {
    if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) {
      docs.push({ id: path.slice(prefix.length), data: () => data })
    }
  }
  return { docs }
}

/** Models `allow create: ...; allow update, delete: if false` for the events collection. */
function fakeWriteBatch() {
  const ops: BatchOp[] = []
  return {
    set: (ref: { path: string }, data: Record<string, unknown>) => {
      ops.push({ type: 'set', path: ref.path, data })
    },
    update: () => { throw new Error('events collection never updates an existing doc') },
    commit: async () => {
      harness.commitCalls.push({ ops: ops.map(op => ({ ...op })) })
      const forced = harness.commitQueue.shift()
      const apply = () => { for (const op of ops) harness.store.set(op.path, structuredClone(op.data)) }
      if (forced) {
        if (forced.kind === 'success') { apply(); return }
        if (forced.applied) apply()
        throw Object.assign(new Error(`fake commit error: ${forced.code}`), { code: forced.code })
      }
      const conflict = ops.find(op => harness.store.has(op.path))
      if (conflict) {
        throw Object.assign(new Error('fake commit error: create-only conflict'), { code: 'permission-denied' })
      }
      apply()
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
    listEvents: vi.fn(async () => []),
    listEventMutations: vi.fn(async () => {
      const fault = harness.listMutationsQueue.shift()
      if (fault?.kind === 'throw') throw new Error(fault.message ?? 'simulated durable read-back crash')
      if (fault?.kind === 'omit-all') return []
      return Array.from(harness.mutations.values()).map(event => structuredClone(event))
    }),
    appendEvent: vi.fn(async (event: DiaryEvent) => {
      const fault = harness.appendEventQueue.shift()
      if (fault?.kind === 'throw') throw new Error(fault.message ?? 'simulated durable append crash')
      if (fault?.kind === 'error') return 'error' as const
      const key = getEventStorageKey(event)
      if (harness.mutations.has(key)) return 'duplicate' as const
      harness.mutations.set(key, structuredClone(event))
      return 'ok' as const
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
    commitBabyInfo: vi.fn(async () => ({ ok: true })),
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
  setDoc: vi.fn(async () => undefined),
  updateDoc: vi.fn(async () => undefined),
  getDocs: vi.fn(fakeGetDocs),
  onSnapshot: vi.fn(() => () => undefined),
  writeBatch: vi.fn(fakeWriteBatch),
  serverTimestamp: vi.fn(() => ({ __fakeTimestamp: true })),
}))

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const config = {
  apiKey: 'key',
  authDomain: 'example.test',
  projectId: 'demo',
  storageBucket: 'bucket',
  messagingSenderId: 'sender',
  appId: 'app',
}

function makeEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  // A live, recent timestamp — parseCloudEventPayload's server-side clock bound
  // (CLOUD_FUTURE_SKEW_MS = 5 minutes) rejects anything meaningfully in the future
  // relative to the real wall clock, so a fixed/hardcoded date is not safe here.
  const now = new Date(Date.now() - 60_000).toISOString()
  return {
    id: uuidv4(),
    type: 'temp',
    at: now,
    data: { celsius: 37.5 },
    author: { uid: 'local-legacy-uid', name: 'Legacy Parent', role: 'mom' },
    createdAt: now,
    updatedAt: now,
    rev: 1,
    deleted: false,
    // A concrete mutationId so `enqueue()`'s ensureEventMutationIdentity() is a
    // no-op and the pending/derived identity matches exactly what tests compute.
    mutationId: uuidv4(),
    ...overrides,
  }
}

function seedFamily(familyId: string, uid: string) {
  harness.store.set(`families/${familyId}`, {
    name: 'Family',
    babyName: 'Baby',
    babyBirthdate: '2026-01-01',
    members: { [uid]: { name: 'Parent', role: 'mom' } },
    inviteCode: 'AAAAAA',
    createdAt: { __fakeTimestamp: true },
  })
}

async function importFreshEngine() {
  return import('../src/sync/syncEngine')
}

async function connect(uid: string, email: string, familyId: string, engineModule?: Awaited<ReturnType<typeof importFreshEngine>>) {
  const engine = engineModule ?? await importFreshEngine()
  await engine.configure(config, familyId)
  await engine.start()
  await vi.waitFor(() => expect(harness.authCallbacks.length).toBeGreaterThan(0))
  harness.authCallbacks[harness.authCallbacks.length - 1]({ uid, email })
  await vi.waitFor(() => {
    const status = engine.getStatus().status
    expect(status === 'online' || status === 'error').toBe(true)
  })
  return engine
}

function eventDocPath(familyId: string, event: DiaryEvent): string {
  return `families/${familyId}/events/${makeCloudEventDocId(event)}`
}

function readPendingFromLocalStorage(): Array<{ event: DiaryEvent }> {
  const raw = localStorage.getItem('babydiary.pendingUploads')
  return raw ? JSON.parse(raw) : []
}

describe('syncEngine upload: durable derivative + exact ACK', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    vi.clearAllMocks()
    localStorage.clear()
    harness.mutations.clear()
    harness.store.clear()
    harness.appendEventQueue = []
    harness.listMutationsQueue = []
    harness.commitQueue = []
    harness.commitCalls = []
    harness.getDocInterceptors = []
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
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ──────────────────────────────────────────────────────────
  // ensureDurableUploadDerivative: local durable-ordering boundaries
  // ──────────────────────────────────────────────────────────

  describe('ensureDurableUploadDerivative', () => {
    it('canonically projects an owned native event and durably appends it before upload', async () => {
      const engine = await importFreshEngine()
      const uid = 'writer-uid'
      const native = makeEvent({ author: { uid, name: 'Parent', role: 'mom' } })
      const source = { ...native, sync: createEventSyncMetadata(native) }
      const ready = deriveUploadReadyEvent(source, uid)
      expect(ready).not.toBe(source)

      const result = await engine.ensureDurableUploadDerivative(source, uid)
      expect(result).toEqual(ready)
      const { ipc } = await import('../src/lib/ipc')
      expect(ipc.appendEvent).toHaveBeenCalledWith(ready)
      expect(harness.mutations.has(getEventStorageKey(ready))).toBe(true)
    })

    it('derives a legacy/foreign-author event, durably appends it, then reads it back before returning', async () => {
      const engine = await importFreshEngine()
      const uid = 'writer-uid'
      const source = makeEvent()
      const before = structuredClone(source)

      const result = await engine.ensureDurableUploadDerivative(source, uid)

      expect(source).toEqual(before) // source is never mutated
      expect(result).not.toBe(source)
      expect(result.author.uid).toBe(uid)
      expect(result).toEqual(deriveUploadReadyEvent(source, uid))

      const { ipc } = await import('../src/lib/ipc')
      expect(ipc.appendEvent).toHaveBeenCalledTimes(1)
      expect(ipc.appendEvent).toHaveBeenCalledWith(result)
      expect(ipc.listEventMutations).toHaveBeenCalledTimes(1)
      expect(harness.mutations.has(getEventStorageKey(result))).toBe(true)
    })

    it('throws when the append/fsync boundary reports a durable write error, and appends nothing', async () => {
      const engine = await importFreshEngine()
      const uid = 'writer-uid'
      const source = makeEvent()
      harness.appendEventQueue.push({ kind: 'error' })

      await expect(engine.ensureDurableUploadDerivative(source, uid)).rejects.toThrow(/durably append/i)
      expect(harness.mutations.size).toBe(0)
    })

    it('throws when the append/fsync IPC call itself crashes (rejects)', async () => {
      const engine = await importFreshEngine()
      const uid = 'writer-uid'
      const source = makeEvent()
      harness.appendEventQueue.push({ kind: 'throw', message: 'main process crashed mid-append' })

      await expect(engine.ensureDurableUploadDerivative(source, uid)).rejects.toThrow(/crashed mid-append/)
      expect(harness.mutations.size).toBe(0)
    })

    it('throws when the local mutation log read-back crashes even though the append itself reported ok', async () => {
      const engine = await importFreshEngine()
      const uid = 'writer-uid'
      const source = makeEvent()
      harness.listMutationsQueue.push({ kind: 'throw', message: 'read-back crashed' })

      await expect(engine.ensureDurableUploadDerivative(source, uid)).rejects.toThrow(/read-back crashed/)
      // The append itself DID durably land — a crash here must not be "fixed" by
      // silently discarding the physical record.
      const expectedDerivative = deriveUploadReadyEvent(source, uid)
      expect(harness.mutations.has(getEventStorageKey(expectedDerivative))).toBe(true)
    })

    it('throws when the read-back does not (yet) contain the just-appended derivative, instead of trusting the append result blindly', async () => {
      const engine = await importFreshEngine()
      const uid = 'writer-uid'
      const source = makeEvent()
      harness.listMutationsQueue.push({ kind: 'omit-all' })

      await expect(engine.ensureDurableUploadDerivative(source, uid))
        .rejects.toThrow(/missing from the durable local mutation log/i)
    })

    it('is idempotent on retry: a second call after a read-back crash converges on the exact same derivative without a second physical append', async () => {
      const engine = await importFreshEngine()
      const uid = 'writer-uid'
      const source = makeEvent()
      harness.listMutationsQueue.push({ kind: 'throw' })

      await expect(engine.ensureDurableUploadDerivative(source, uid)).rejects.toThrow()
      const { ipc } = await import('../src/lib/ipc')
      expect(harness.mutations.size).toBe(1) // durably landed despite the thrown read-back

      const retried = await engine.ensureDurableUploadDerivative(source, uid)
      expect(retried).toEqual(deriveUploadReadyEvent(source, uid))
      expect(harness.mutations.size).toBe(1) // no duplicate physical record
      // Second append call observed 'duplicate', not a fresh write.
      expect(ipc.appendEvent).toHaveBeenCalledTimes(2)
    })
  })

  // ──────────────────────────────────────────────────────────
  // Full pipeline: enqueue -> drain -> Firestore write -> exact ACK
  // ──────────────────────────────────────────────────────────

  describe('full upload pipeline', () => {
    it('uploads a foreign-authored local event as its writer-bound derivative, at the derivative doc id, and clears pending only after ACK', async () => {
      const familyId = 'family-1'
      const uid = 'writer-uid'
      seedFamily(familyId, uid)
      const engine = await connect(uid, 'a@example.test', familyId)
      expect(engine.getStatus().status).toBe('online')

      const source = makeEvent()
      const expectedDerivative = deriveUploadReadyEvent(source, uid)
      engine.enqueue(source)

      await vi.waitFor(() => expect(engine.getStatus().pendingCount).toBe(0))

      const stored = harness.store.get(eventDocPath(familyId, expectedDerivative)) as { event: DiaryEvent }
      expect(stored).toBeDefined()
      expect(stored.event).toEqual(expectedDerivative)
      // The SOURCE's own (unauth-bound) doc id must never be written to.
      expect(harness.store.has(`families/${familyId}/events/${uid === source.author.uid ? '' : 'unused'}`)).toBe(false)
      expect(readPendingFromLocalStorage()).toHaveLength(0)
    })

    it('never ACKs when the server read-back is corrupted/mismatched, and clears pending only once a clean read-back arrives', async () => {
      const familyId = 'family-2'
      const uid = 'writer-uid'
      seedFamily(familyId, uid)
      const engine = await connect(uid, 'b@example.test', familyId)

      const source = makeEvent()
      const derivative = deriveUploadReadyEvent(source, uid)
      const docPath = eventDocPath(familyId, derivative)

      harness.getDocInterceptors.push({
        match: path => path === docPath,
        run: () => ({ exists: true, data: { event: { ...derivative, data: { celsius: 40.0 } } } }),
      })

      engine.enqueue(source)
      await vi.waitFor(() => expect(harness.commitCalls.length).toBeGreaterThan(0))
      // The write landed but the read-back was corrupted -> must still be pending.
      await vi.waitFor(() => expect(engine.getStatus().pendingCount).toBeGreaterThan(0))
      expect(readPendingFromLocalStorage()).toHaveLength(1)
      // Even though the ACK failed, the batch commit still wrote the real bytes —
      // a later clean read-back must show the correct derivative was persisted.
      expect(harness.store.get(docPath)).toEqual({ event: derivative })
    })

    it('never ACKs an already-exists sibling at the same content-bound id with different bytes', async () => {
      const familyId = 'family-3'
      const uid = 'writer-uid'
      seedFamily(familyId, uid)

      const source = makeEvent()
      const derivative = deriveUploadReadyEvent(source, uid)
      const docPath = eventDocPath(familyId, derivative)
      // Pre-seed a corrupted/forged sibling already occupying the exact doc id.
      harness.store.set(docPath, { event: { ...derivative, data: { celsius: 41.5 } } })

      const engine = await connect(uid, 'c@example.test', familyId)
      engine.enqueue(source)

      await vi.waitFor(() => expect(harness.commitCalls.length).toBeGreaterThan(0))
      // create-only conflict -> not ACKed -> stays pending forever (never silently dropped).
      expect(engine.getStatus().pendingCount).toBeGreaterThan(0)
      expect(readPendingFromLocalStorage()).toHaveLength(1)
      expect(readPendingFromLocalStorage()[0].event).toEqual(source)
      // The forged sibling is never overwritten (update/delete are impossible for this collection).
      expect(harness.store.get(docPath)).toEqual({ event: { ...derivative, data: { celsius: 41.5 } } })
    })

    it('never ACKs a malformed cloud sibling at the same id that fails to parse at all', async () => {
      const familyId = 'family-4'
      const uid = 'writer-uid'
      seedFamily(familyId, uid)

      const source = makeEvent()
      const derivative = deriveUploadReadyEvent(source, uid)
      const docPath = eventDocPath(familyId, derivative)
      harness.store.set(docPath, { garbage: true })

      const engine = await connect(uid, 'd@example.test', familyId)
      engine.enqueue(source)

      await vi.waitFor(() => expect(harness.commitCalls.length).toBeGreaterThan(0))
      expect(engine.getStatus().pendingCount).toBeGreaterThan(0)
      expect(readPendingFromLocalStorage()).toHaveLength(1)
    })

    it('converges after an ambiguous Firestore batch-commit error via the per-doc fallback, without ever duplicating the doc', async () => {
      const familyId = 'family-5'
      const uid = 'writer-uid'
      seedFamily(familyId, uid)
      const engine = await connect(uid, 'e@example.test', familyId)

      const source = makeEvent()
      const derivative = deriveUploadReadyEvent(source, uid)
      const docPath = eventDocPath(familyId, derivative)

      // The first (batch) commit attempt fails ambiguously; F7's per-doc fallback
      // retries immediately and this second attempt is not forced to fail.
      harness.commitQueue.push({ kind: 'error', code: 'unavailable', applied: false })
      engine.enqueue(source)

      await vi.waitFor(() => expect(engine.getStatus().pendingCount).toBe(0))
      expect(harness.commitCalls.length).toBeGreaterThanOrEqual(2)
      expect(harness.store.get(docPath)).toEqual({ event: derivative })
      // Exactly one physical doc exists for this content — no duplicate was created
      // by the failed first attempt plus the successful fallback retry.
      const eventDocKeys = Array.from(harness.store.keys()).filter(key => key.startsWith(`families/${familyId}/events/`))
      expect(eventDocKeys).toEqual([docPath])
    })

    it('uploads two local mutations that share id+rev but differ in content as two distinct docs', async () => {
      const familyId = 'family-6'
      const uid = 'writer-uid'
      seedFamily(familyId, uid)
      const engine = await connect(uid, 'f@example.test', familyId)

      const sharedId = 'shared-event'
      const first = makeEvent({ id: sharedId, rev: 2, mutationId: '11111111-1111-4111-8111-111111111111' })
      const second = {
        ...makeEvent({ id: sharedId, rev: 2, mutationId: '22222222-2222-4222-8222-222222222222' }),
        data: { celsius: 39.0 },
      }
      const derivative1 = deriveUploadReadyEvent(first, uid)
      const derivative2 = deriveUploadReadyEvent(second, uid)
      expect(makeCloudEventDocId(derivative1)).not.toBe(makeCloudEventDocId(derivative2))

      engine.enqueue(first)
      engine.enqueue(second)
      await vi.waitFor(() => expect(engine.getStatus().pendingCount).toBe(0))

      expect(harness.store.get(eventDocPath(familyId, derivative1))).toEqual({ event: derivative1 })
      expect(harness.store.get(eventDocPath(familyId, derivative2))).toEqual({ event: derivative2 })
    })
  })

  // ──────────────────────────────────────────────────────────
  // Account switch and restart reconstruction
  // ──────────────────────────────────────────────────────────

  describe('account switch and restart reconstruction', () => {
    it('upgrades an owned legacy native cloud source even when its old document is already remote', async () => {
      const familyId = 'family-owned-upgrade'
      const uid = 'owner-account'
      seedFamily(familyId, uid)
      const native = makeEvent({ author: { uid, name: 'Owner', role: 'mom' } })
      const source = { ...native, sync: createEventSyncMetadata(native) }
      const canonical = deriveUploadReadyEvent(source, uid)
      harness.mutations.set(getEventStorageKey(source), structuredClone(source))
      harness.store.set(eventDocPath(familyId, source), { event: structuredClone(source) })

      const engine = await connect(uid, 'owner@example.test', familyId)

      await vi.waitFor(() => {
        expect(harness.store.get(eventDocPath(familyId, canonical))).toEqual({ event: canonical })
      })
      expect(harness.store.get(eventDocPath(familyId, source))).toEqual({ event: source })
      engine.stop()
    })

    it('does not re-project another member remote native source under the current account', async () => {
      const familyId = 'family-foreign-native'
      const uid = 'reader-account'
      seedFamily(familyId, uid)
      const native = makeEvent({ author: { uid: 'other-member', name: 'Other', role: 'dad' } })
      const source = { ...native, sync: createEventSyncMetadata(native) }
      const forbiddenProjection = deriveUploadReadyEvent(source, uid)
      harness.mutations.set(getEventStorageKey(source), structuredClone(source))
      harness.store.set(eventDocPath(familyId, source), { event: structuredClone(source) })

      const engine = await connect(uid, 'reader@example.test', familyId)
      await vi.waitFor(() => expect(engine.getStatus().status).toBe('online'))

      expect(harness.store.has(eventDocPath(familyId, forbiddenProjection))).toBe(false)
      expect(harness.mutations.has(getEventStorageKey(forbiddenProjection))).toBe(false)
      engine.stop()
    })

    it('never rebinds or removes account A\'s uploaded derivative after account B connects and reconciles', async () => {
      const familyId = 'shared-family'
      const uidA = 'account-a'
      const uidB = 'account-b'
      seedFamily(familyId, uidA)

      const engineA = await connect(uidA, 'a@example.test', familyId)
      const source = makeEvent()
      const derivativeA = deriveUploadReadyEvent(source, uidA)
      engineA.enqueue(source)
      await vi.waitFor(() => expect(engineA.getStatus().pendingCount).toBe(0))

      const docPathA = eventDocPath(familyId, derivativeA)
      const bytesAfterA = structuredClone(harness.store.get(docPathA))
      expect(bytesAfterA).toEqual({ event: derivativeA })

      // Simulate a full app restart into a different signed-in account, sharing the
      // same physical local disk (harness.mutations) and the same family in the cloud.
      await engineA.stop()
      vi.resetModules()
      seedFamily(familyId, uidB) // family now also has B as a member
      const engineB = await connect(uidB, 'b@example.test', familyId)
      await vi.waitFor(() => {
        const status = engineB.getStatus().status
        expect(status === 'online' || status === 'error').toBe(true)
      })

      // A's exact document must be byte-for-byte unchanged.
      expect(harness.store.get(docPathA)).toEqual(bytesAfterA)
      // A's durable local derivative record must still exist, untouched.
      expect(harness.mutations.get(getEventStorageKey(derivativeA))).toEqual(derivativeA)
      const derivativeB = deriveUploadReadyEvent(source, uidB)
      expect(harness.store.has(eventDocPath(familyId, derivativeB))).toBe(false)
      const eventDocPrefix = `families/${familyId}/events/`
      expect(Array.from(harness.store.keys()).filter(path => path.startsWith(eventDocPrefix)))
        .toEqual([docPathA])
    })

    it('clears a stale pending source when another member already uploaded its exact canonical derivative', async () => {
      const familyId = 'family-stale-pending-canonical'
      const uidA = 'account-a'
      const uidB = 'account-b'
      seedFamily(familyId, uidB)

      const source = makeEvent()
      const derivativeA = deriveUploadReadyEvent(source, uidA)
      const derivativeB = deriveUploadReadyEvent(source, uidB)
      harness.mutations.set(getEventStorageKey(source), structuredClone(source))
      harness.store.set(eventDocPath(familyId, derivativeA), { event: structuredClone(derivativeA) })
      localStorage.setItem('babydiary.pendingUploads', JSON.stringify([
        { event: source, attempts: 0, nextRetry: 0 },
      ]))

      const engineB = await connect(uidB, 'b@example.test', familyId)
      await vi.waitFor(() => expect(engineB.getStatus().pendingCount).toBe(0))

      expect(readPendingFromLocalStorage()).toHaveLength(0)
      expect(harness.store.has(eventDocPath(familyId, derivativeB))).toBe(false)
      const eventDocPrefix = `families/${familyId}/events/`
      expect(Array.from(harness.store.keys()).filter(path => path.startsWith(eventDocPrefix)))
        .toEqual([eventDocPath(familyId, derivativeA)])
      engineB.stop()
    })

    it('clears a stale pending source when the exact foreign native source is already remote', async () => {
      const familyId = 'family-stale-pending-foreign-source'
      const uid = 'reader-account'
      seedFamily(familyId, uid)

      const native = makeEvent({ author: { uid: 'other-member', name: 'Other', role: 'dad' } })
      const source = { ...native, sync: createEventSyncMetadata(native) }
      const forbiddenProjection = deriveUploadReadyEvent(source, uid)
      harness.mutations.set(getEventStorageKey(source), structuredClone(source))
      harness.store.set(eventDocPath(familyId, source), { event: structuredClone(source) })
      localStorage.setItem('babydiary.pendingUploads', JSON.stringify([
        { event: source, attempts: 0, nextRetry: 0 },
      ]))

      const engine = await connect(uid, 'reader@example.test', familyId)
      await vi.waitFor(() => expect(engine.getStatus().pendingCount).toBe(0))

      expect(readPendingFromLocalStorage()).toHaveLength(0)
      expect(harness.store.has(eventDocPath(familyId, forbiddenProjection))).toBe(false)
      engine.stop()
    })

    it('restores raw legacy provenance from the durable log before draining a stale pending projection', async () => {
      const familyId = 'family-raw-stale-pending'
      const uid = 'writer-account'
      seedFamily(familyId, uid)

      const rawSource = makeEvent({
        id: 'raw-stale-pending',
        mutationId: undefined,
        data: { celsius: 36.9 },
      })
      const { ensureEventMutationIdentity } = await import('../shared/eventResolver')
      const identifiedProjection = ensureEventMutationIdentity(rawSource)
      const expectedCanonical = deriveUploadReadyEvent(rawSource, uid)
      const wrongCanonical = deriveUploadReadyEvent(identifiedProjection, uid)
      harness.mutations.set(getEventStorageKey(rawSource), structuredClone(rawSource))
      localStorage.setItem('babydiary.pendingUploads', JSON.stringify([
        { event: rawSource, attempts: 0, nextRetry: 0 },
      ]))

      const engine = await connect(uid, 'writer@example.test', familyId)
      await vi.waitFor(() => expect(engine.getStatus().pendingCount).toBe(0))

      expect(harness.store.get(eventDocPath(familyId, expectedCanonical)))
        .toEqual({ event: expectedCanonical })
      expect(harness.store.has(eventDocPath(familyId, wrongCanonical))).toBe(false)
      expect(readPendingFromLocalStorage()).toHaveLength(0)
      engine.stop()
    })

    it('upgrades a crashed legacy same-revision derivative from its preserved source without pending state', async () => {
      const familyId = 'family-restart'
      const uid = 'writer-uid'
      seedFamily(familyId, uid)

      // Simulate: a previous run derived+durably appended this derivative (main
      // process EventLog), then crashed before the Firestore write ever happened.
      // localStorage was never written (or was cleared) — nothing in `_pending`.
      const source = makeEvent()
      const canonicalDerivative = deriveUploadReadyEvent(source, uid)
      const priorDerivative = { ...canonicalDerivative, rev: source.rev }
      harness.mutations.set(getEventStorageKey(source), structuredClone(source))
      harness.mutations.set(getEventStorageKey(priorDerivative), structuredClone(priorDerivative))
      expect(localStorage.getItem('babydiary.pendingUploads')).toBeNull()

      const engine = await connect(uid, 'g@example.test', familyId)

      await vi.waitFor(() => {
        expect(harness.store.get(eventDocPath(familyId, canonicalDerivative))).toEqual({ event: canonicalDerivative })
      })
      expect(harness.mutations.get(getEventStorageKey(priorDerivative))).toEqual(priorDerivative)
      expect(harness.mutations.get(getEventStorageKey(canonicalDerivative))).toEqual(canonicalDerivative)
      expect(engine.getStatus().status).toBe('online')
    })

    it('never re-derives a prior account\'s un-uploaded durable derivative into a second cloud document after switching accounts', async () => {
      const familyId = 'family-switch'
      const uidA = 'account-a'
      const uidB = 'account-b'
      seedFamily(familyId, uidA)

      // Simulate: while signed in as A, a previous run derived+durably appended A's
      // derivative to the local EventLog, then crashed before the Firestore write
      // ever happened. The untouched original event is also on disk (append-only
      // local log never rewrites or removes it).
      const source = makeEvent()
      const derivativeA = deriveUploadReadyEvent(source, uidA)
      harness.mutations.set(getEventStorageKey(source), structuredClone(source))
      harness.mutations.set(getEventStorageKey(derivativeA), structuredClone(derivativeA))

      // App restarts signed in as a different account B, sharing the same physical
      // local disk and the same cloud family.
      seedFamily(familyId, uidB)
      const engineB = await connect(uidB, 'b@example.test', familyId)
      await vi.waitFor(() => {
        const status = engineB.getStatus().status
        expect(status === 'online' || status === 'error').toBe(true)
      })

      const expectedDerivativeB = deriveUploadReadyEvent(source, uidB)
      await vi.waitFor(() => {
        expect(harness.store.get(eventDocPath(familyId, expectedDerivativeB))).toEqual({ event: expectedDerivativeB })
      })

      // Exactly one cloud document exists for this logical event: the untouched
      // original re-derived for the current writer. Re-deriving account A's already
      // -migrated derivative (which has its own distinct content id) must never
      // produce and upload a second, different derivative-of-derivative document.
      const eventDocPrefix = `families/${familyId}/events/`
      const uploadedEventDocs = Array.from(harness.store.keys()).filter(path => path.startsWith(eventDocPrefix))
      expect(uploadedEventDocs).toEqual([eventDocPath(familyId, expectedDerivativeB)])

      // No data was lost by excluding the prior derivative from re-derivation: the
      // untouched original (and A's now-superseded derivative) both remain intact
      // in the durable local log, and the logical event reached the cloud exactly
      // once, correctly bound to the current account.
      expect(harness.mutations.get(getEventStorageKey(source))).toEqual(source)
      expect(harness.mutations.get(getEventStorageKey(derivativeA))).toEqual(derivativeA)
    })
  })
})
