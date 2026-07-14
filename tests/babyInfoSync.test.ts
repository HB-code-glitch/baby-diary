import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AppSettings,
  BabyInfoMutation,
  BabyInfoPendingPageRequest,
  BabyInfoSettingsCommitOperation,
} from '../shared/types'
import { getBabyInfoMutationKey } from '../shared/babyInfoResolver'
import { SettingsStore } from '../electron/store/settings'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function refPath(ref: unknown): string {
  return (ref as { path: string }).path
}

function documentSnapshot(documentPath: string, data: Record<string, unknown> | undefined) {
  return {
    id: documentPath.split('/').at(-1)!,
    ref: { path: documentPath },
    exists: () => data !== undefined,
    data: () => data === undefined ? undefined : clone(data),
  }
}

const firestore = vi.hoisted(() => ({
  documents: new Map<string, Record<string, unknown>>(),
  pageSizes: [] as number[],
  requestedLimits: [] as number[],
  failGetDocs: 0,
  failWrites: 0,
  reset() {
    this.documents.clear()
    this.pageSizes.length = 0
    this.requestedLimits.length = 0
    this.failGetDocs = 0
    this.failWrites = 0
  },
}))

vi.mock('firebase/firestore', () => {
  type Constraint = { kind: 'orderBy' | 'startAfter' | 'limit'; value: unknown }
  const collection = (parent: unknown, ...segments: string[]) => {
    const prefix = parent && typeof parent === 'object' && 'path' in parent
      ? `${(parent as { path: string }).path}/`
      : ''
    return { path: `${prefix}${segments.join('/')}`, constraints: [] as Constraint[] }
  }
  const doc = (parent: unknown, ...segments: string[]) => {
    const prefix = parent && typeof parent === 'object' && 'path' in parent
      ? `${(parent as { path: string }).path}/`
      : ''
    return { path: `${prefix}${segments.join('/')}`, id: segments.at(-1)! }
  }
  const query = (ref: unknown, ...constraints: Constraint[]) => ({
    path: refPath(ref), constraints,
  })
  const orderBy = (value: unknown) => ({ kind: 'orderBy' as const, value })
  const documentId = () => '__name__'
  const startAfter = (value: unknown) => ({ kind: 'startAfter' as const, value })
  const limit = (value: number) => ({ kind: 'limit' as const, value })
  const getDoc = vi.fn(async (ref: unknown) => (
    documentSnapshot(refPath(ref), firestore.documents.get(refPath(ref)))
  ))
  const setDoc = vi.fn(async (ref: unknown, data: Record<string, unknown>) => {
    if (firestore.failWrites > 0) {
      firestore.failWrites -= 1
      throw Object.assign(new Error('offline'), { code: 'unavailable' })
    }
    const target = refPath(ref)
    if (firestore.documents.has(target)) {
      throw Object.assign(new Error('create-only'), { code: 'permission-denied' })
    }
    firestore.documents.set(target, clone(data))
  })
  const updateDoc = vi.fn(async (ref: unknown, patch: Record<string, unknown>) => {
    const target = refPath(ref)
    const existing = firestore.documents.get(target)
    if (!existing) throw new Error(`missing document: ${target}`)
    firestore.documents.set(target, { ...existing, ...clone(patch) })
  })
  const getDocs = vi.fn(async (ref: unknown) => {
    if (firestore.failGetDocs > 0) {
      firestore.failGetDocs -= 1
      throw Object.assign(new Error('network unavailable'), { code: 'unavailable' })
    }
    const record = ref as { path: string; constraints?: Constraint[] }
    const prefix = `${record.path}/`
    let docs = Array.from(firestore.documents.entries())
      .filter(([target]) => target.startsWith(prefix) && !target.slice(prefix.length).includes('/'))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([target, data]) => documentSnapshot(target, data))
    const after = record.constraints?.find(item => item.kind === 'startAfter')?.value
    const pageLimit = record.constraints?.find(item => item.kind === 'limit')?.value as number | undefined
    if (typeof after === 'string') docs = docs.filter(item => item.id > after)
    if (pageLimit !== undefined) {
      firestore.requestedLimits.push(pageLimit)
      docs = docs.slice(0, pageLimit)
    }
    firestore.pageSizes.push(docs.length)
    return { docs }
  })
  return {
    collection,
    doc,
    query,
    orderBy,
    documentId,
    startAfter,
    limit,
    getDoc,
    setDoc,
    updateDoc,
    getDocs,
  }
})

let store: SettingsStore
const ipcMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  commitBabyInfo: vi.fn(),
  listPendingBabyInfo: vi.fn(),
  getBabyInfoSummary: vi.fn(),
  getBabyInfoMutation: vi.fn(),
}))

vi.mock('../src/lib/ipc', () => ({ ipc: ipcMock }))

const db = { kind: 'firestore' }

function baseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    baby: { name: 'Before', birthdate: '2026-01-01' },
    profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
    familyId: 'family-A',
    firebase: null,
    ...overrides,
  }
}

function mutation(index: number, overrides: Partial<BabyInfoMutation> = {}): BabyInfoMutation {
  return {
    mutationId: `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    familyId: 'family-A',
    babyName: `Baby ${index}`,
    babyBirthdate: '2026-02-02',
    logicalClock: index + 1,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
    authorId: 'user-1',
    origin: 'user',
    ...overrides,
  }
}

function installStore(tmpDir: string, settings: AppSettings): void {
  fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  store = new SettingsStore(tmpDir)
  ipcMock.getSettings.mockReset().mockImplementation(async () => clone(store.get()))
  ipcMock.saveSettings.mockReset().mockImplementation(async next => clone(store.save(next)))
  ipcMock.commitBabyInfo.mockReset().mockImplementation(async (operation: BabyInfoSettingsCommitOperation) => (
    clone(store.commitBabyInfo(operation))
  ))
  ipcMock.listPendingBabyInfo.mockReset().mockImplementation(async (request: BabyInfoPendingPageRequest) => (
    clone(store.listPendingBabyInfo(request))
  ))
  ipcMock.getBabyInfoSummary.mockReset().mockImplementation(async (familyId: string) => (
    clone(store.getBabyInfoSummary(familyId))
  ))
  ipcMock.getBabyInfoMutation.mockReset().mockImplementation(async (familyId: string, key: string) => {
    const journal = store as SettingsStore & {
      getBabyInfoMutation(familyId: string, key: string): BabyInfoMutation | undefined
    }
    const candidate = journal.getBabyInfoMutation(familyId, key)
    return candidate === undefined ? undefined : clone(candidate)
  })
}

async function options(familyData?: Record<string, unknown>) {
  const ops = await import('firebase/firestore')
  const familyRef = ops.doc(db as never, 'families', 'family-A')
  if (!firestore.documents.has('families/family-A')) {
    firestore.documents.set('families/family-A', {
      babyName: '', babyBirthdate: '', ...(familyData ?? {}),
    })
  }
  return {
    db: db as never,
    familyId: 'family-A',
    familyRef,
    familyData: (familyData ?? firestore.documents.get('families/family-A') ?? {}),
    ops,
  }
}

describe('baby-info delta sync over the main journal', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.resetModules()
    firestore.reset()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-sync-v2-'))
    installStore(tmpDir, baseSettings({ baby: { name: '', birthdate: '' } }))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('persists an edit through a bounded delta instead of round-tripping AppSettings history', async () => {
    const sync = await import('../src/sync/babyInfoSync')
    const next = { ...store.get(), baby: { ...store.get().baby, name: 'After', birthdate: '2026-03-03' } }

    const result = await sync.persistSettingsWithBabyInfoMutation(next)

    expect(ipcMock.commitBabyInfo).toHaveBeenCalledWith({
      kind: 'user-edit',
      familyId: 'family-A',
      babyName: 'After',
      babyBirthdate: '2026-03-03',
    })
    expect(result.settings.babyInfoSync).toBeUndefined()
    expect(result.settings.baby.name).toBe('After')
    expect(JSON.stringify(ipcMock.commitBabyInfo.mock.calls[0][0]).length).toBeLessThan(5_000)
  })

  it('accepts exactly { mutation } and rejects bare or extra cloud envelope keys', async () => {
    const sync = await import('../src/sync/babyInfoSync')
    const item = mutation(1)
    const id = sync.makeBabyInfoDocId(item)

    expect(sync.parseCloudBabyInfoDocument(id, { mutation: item }, 'family-A')).toEqual(item)
    expect(sync.parseCloudBabyInfoDocument(id, item as unknown as Record<string, unknown>, 'family-A')).toBeNull()
    expect(sync.parseCloudBabyInfoDocument(id, { mutation: item, extra: true }, 'family-A')).toBeNull()
    expect(sync.parseCloudBabyInfoDocument(id, { mutation: { ...item, familyId: 'family-B' } }, 'family-A')).toBeNull()
  })

  it('keeps a mismatched existing cloud document pending because exact read-back never succeeds', async () => {
    const sync = await import('../src/sync/babyInfoSync')
    await sync.persistSettingsWithBabyInfoMutation({
      ...store.get(),
      baby: { ...store.get().baby, name: 'Local pending' },
    })
    const pending = store.listPendingBabyInfo({ familyId: 'family-A', limit: 500 }).items
      .find(item => item.babyName === 'Local pending')!
    firestore.documents.set(
      `families/family-A/babyInfoMutations/${sync.makeBabyInfoDocId(pending)}`,
      { mutation: { ...pending, babyName: 'Tampered' } },
    )

    const result = await sync.reconcileFamilyBabyInfo(await options())

    expect(result.needsRetry).toBe(true)
    expect(result.activePendingCount).toBeGreaterThan(0)
    expect(store.listPendingBabyInfo({ familyId: 'family-A', limit: 500 }).items)
      .toContainEqual(pending)
  })

  it('uses a correctness-preserving paged scan for more than 10,000 remote originals', async () => {
    installStore(tmpDir, baseSettings({ baby: { name: '', birthdate: '' } }))
    const sync = await import('../src/sync/babyInfoSync')
    const total = 10_025
    for (let index = 0; index < total; index += 1) {
      const item = mutation(index + 1_000)
      firestore.documents.set(
        `families/family-A/babyInfoMutations/${sync.makeBabyInfoDocId(item)}`,
        { mutation: item },
      )
    }

    const result = await sync.reconcileFamilyBabyInfo(await options())

    expect(result.needsRetry).toBe(false)
    expect(store.getBabyInfoSummary('family-A')).toMatchObject({
      mutationCount: total,
      pendingCount: 0,
      winner: expect.objectContaining({ logicalClock: total + 1_000 }),
    })
    expect(firestore.pageSizes.length).toBeGreaterThan(40)
    expect(Math.max(...firestore.pageSizes)).toBeLessThanOrEqual(250)
    expect(new Set(firestore.requestedLimits)).toEqual(new Set([250]))
    for (const [operation] of ipcMock.commitBabyInfo.mock.calls) {
      expect(operation.discoveredMutations?.length ?? 0).toBeLessThanOrEqual(250)
      expect(JSON.stringify(operation).length).toBeLessThan(512_000)
    }
  }, 30_000)

  it('turns a v0.3.8 pair-only family update into a deterministic auth-bound bridge bound to the prior winner', async () => {
    installStore(tmpDir, baseSettings({ baby: { name: '', birthdate: '' } }))
    const sync = await import('../src/sync/babyInfoSync')
    const prior = mutation(20, { babyName: 'Prior winner', logicalClock: 10 })
    const priorKey = getBabyInfoMutationKey(prior)
    firestore.documents.set(
      `families/family-A/babyInfoMutations/${sync.makeBabyInfoDocId(prior)}`,
      { mutation: prior },
    )
    const familyData = {
      babyName: 'Old client edit',
      babyBirthdate: '2026-05-05',
      babyInfoWinnerKey: priorKey,
      babyInfoWinnerMutationId: prior.mutationId,
      babyInfoWinnerLogicalClock: prior.logicalClock,
      babyInfoWinnerUpdatedAt: prior.updatedAt,
      babyInfoWinnerAuthorId: prior.authorId,
      babyInfoWinnerOrigin: prior.origin,
    }
    firestore.documents.set('families/family-A', clone(familyData))

    const result = await sync.reconcileFamilyBabyInfo(await options(familyData))
    const firstWinner = store.getBabyInfoSummary('family-A').winner!
    // Hardened rules reject a bare v0.3.8 pair-only write, so the bridge
    // this cycle uploads must be auth-bound (never the unauthenticated
    // `legacy-cloud-bridge` sentinel) or the real emulator would reject it.
    expect(firstWinner).toMatchObject({
      babyName: 'Old client edit',
      babyBirthdate: '2026-05-05',
      logicalClock: 11,
      origin: 'user',
      authorId: 'user-1',
    })
    expect(store.getBabyInfoSummary('family-A').pendingCount).toBe(0)
    expect(result.legacyClientUpdateRequired).toBe(true)

    // Replaying the same old-client projection in the opposite device order
    // deduplicates the deterministic bridge and cannot revert the winner.
    await sync.reconcileFamilyBabyInfo(await options(familyData))
    expect(store.getBabyInfoSummary('family-A').winner).toEqual(firstWinner)
    expect(store.getBabyInfoSummary('family-A').mutationCount).toBe(2)
  })

  it.each([
    ['marker sorts before W2', 120, 121],
    ['W2 sorts before marker', 220, 119],
  ])('preserves legacy pair L from marker W1 even when concurrent W2 is already the winner: %s', async (
    _label,
    markerId,
    winnerId,
  ) => {
    installStore(tmpDir, baseSettings({ baby: { name: '', birthdate: '' } }))
    const sync = await import('../src/sync/babyInfoSync')
    const marker = mutation(markerId, {
      babyName: 'Marker W1',
      logicalClock: 10,
      updatedAt: '2026-07-13T10:00:00.000Z',
    })
    const concurrentWinner = mutation(winnerId, {
      babyName: 'Concurrent W2',
      logicalClock: 20,
      updatedAt: '2026-07-13T10:00:01.000Z',
    })
    for (const item of [marker, concurrentWinner]) {
      firestore.documents.set(
        `families/family-A/babyInfoMutations/${sync.makeBabyInfoDocId(item)}`,
        { mutation: item },
      )
    }
    const familyData = {
      babyName: 'Legacy pair L',
      babyBirthdate: '2026-05-05',
      babyInfoWinnerKey: getBabyInfoMutationKey(marker),
      babyInfoWinnerMutationId: marker.mutationId,
      babyInfoWinnerLogicalClock: marker.logicalClock,
      babyInfoWinnerUpdatedAt: marker.updatedAt,
      babyInfoWinnerAuthorId: marker.authorId,
      babyInfoWinnerOrigin: marker.origin,
    }
    firestore.documents.set('families/family-A', clone(familyData))

    await sync.reconcileFamilyBabyInfo(await options(familyData))

    expect(store.getBabyInfoSummary('family-A')).toMatchObject({
      mutationCount: 3,
      pendingCount: 0,
      winner: concurrentWinner,
    })
    const journalText = fs.readFileSync(path.join(tmpDir, 'baby-info-journal-v1.jsonl'), 'utf8')
    expect(journalText).toContain('Legacy pair L')

    // Restart/retry must deduplicate the marker-bound bridge physically.
    installStore(tmpDir, store.get())
    await sync.reconcileFamilyBabyInfo(await options(familyData))
    expect(store.getBabyInfoSummary('family-A').mutationCount).toBe(3)
  })

  it('does not invent a rolling bridge when the family marker child is missing', async () => {
    installStore(tmpDir, baseSettings({ baby: { name: '', birthdate: '' } }))
    const sync = await import('../src/sync/babyInfoSync')
    const missingMarker = mutation(300, { babyName: 'Missing W1', logicalClock: 10 })
    const winner = mutation(301, { babyName: 'Winner W2', logicalClock: 20 })
    firestore.documents.set(
      `families/family-A/babyInfoMutations/${sync.makeBabyInfoDocId(winner)}`,
      { mutation: winner },
    )
    const familyData = {
      babyName: 'Untrusted legacy pair',
      babyBirthdate: '2026-05-05',
      babyInfoWinnerKey: getBabyInfoMutationKey(missingMarker),
    }

    await sync.reconcileFamilyBabyInfo(await options(familyData))

    expect(store.getBabyInfoSummary('family-A')).toMatchObject({
      mutationCount: 1,
      winner,
    })
    expect(fs.readFileSync(path.join(tmpDir, 'baby-info-journal-v1.jsonl'), 'utf8'))
      .not.toContain('Untrusted legacy pair')
  })

  it('advances a stable pending cursor past a failed key and drains later pages in the same cycle', async () => {
    installStore(tmpDir, baseSettings({ baby: { name: '', birthdate: '' } }))
    const discovered = Array.from({ length: 205 }, (_, index) => mutation(1_000 + index))
    store.commitBabyInfo({
      kind: 'reconcile',
      familyId: 'family-A',
      discoveredMutations: discovered,
      exactAcknowledgedMutationKeys: [],
    })
    firestore.failWrites = 1
    const sync = await import('../src/sync/babyInfoSync')

    const result = await sync.reconcileFamilyBabyInfo(await options())

    expect(result.needsRetry).toBe(true)
    expect(result.activePendingCount).toBe(1)
    expect(store.listPendingBabyInfo({ familyId: 'family-A', limit: 500 }).items).toHaveLength(1)
    expect(ipcMock.listPendingBabyInfo.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(ipcMock.listPendingBabyInfo.mock.calls.slice(1).every(
      ([request]) => typeof request.afterKey === 'string',
    )).toBe(true)
  })

  it('propagates an initial paged read failure even when there were zero local pending items', async () => {
    installStore(tmpDir, baseSettings({ baby: { name: '', birthdate: '' } }))
    firestore.failGetDocs = 1
    const sync = await import('../src/sync/babyInfoSync')

    await expect(sync.reconcileFamilyBabyInfo(await options())).rejects.toMatchObject({ code: 'unavailable' })
    expect(store.getBabyInfoSummary('family-A').pendingCount).toBe(0)
  })
})

describe('monotonic atomic projection and hardened v0.3.8 rollout', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.resetModules()
    firestore.reset()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-sync-v3-'))
    installStore(tmpDir, baseSettings({ baby: { name: '', birthdate: '' } }))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function projectionFrom(mut: BabyInfoMutation) {
    return {
      babyName: mut.babyName,
      babyBirthdate: mut.babyBirthdate,
      babyInfoWinnerKey: getBabyInfoMutationKey(mut),
      babyInfoWinnerMutationId: mut.mutationId,
      babyInfoWinnerLogicalClock: mut.logicalClock,
      babyInfoWinnerUpdatedAt: mut.updatedAt,
      babyInfoWinnerAuthorId: mut.authorId,
      babyInfoWinnerOrigin: mut.origin,
    }
  }

  it('never lets a stale lower-clock local winner regress an already-projected higher winner', async () => {
    const sync = await import('../src/sync/babyInfoSync')
    const externalWinner = mutation(600, { babyName: 'Winner B', logicalClock: 999_999 })
    const familyData = projectionFrom(externalWinner)
    const stale = mutation(601, { babyName: 'Stale A', logicalClock: 50 })
    store.commitBabyInfo({
      kind: 'reconcile', familyId: 'family-A',
      discoveredMutations: [stale], exactAcknowledgedMutationKeys: [],
    })

    const result = await sync.reconcileFamilyBabyInfo(await options(familyData))

    expect(result.needsRetry).toBe(false)
    expect(firestore.documents.get('families/family-A')).toMatchObject(familyData)
  })

  it.each([
    'loser projected first, winner reconciles second',
    'winner projected first, loser reconciles second',
  ])('converges an equal-clock projection race to the deterministic key winner: %s', async label => {
    const sync = await import('../src/sync/babyInfoSync')
    const m1 = mutation(700, { babyName: 'Device M1', logicalClock: 5_000 })
    const m2 = mutation(701, { babyName: 'Device M2', logicalClock: 5_000 })
    const key1 = getBabyInfoMutationKey(m1)
    const key2 = getBabyInfoMutationKey(m2)
    expect(key1).not.toBe(key2)
    const [loser, winner] = key1 < key2 ? [m1, m2] : [m2, m1]
    const alreadyProjected = label.startsWith('loser') ? loser : winner
    const reconciling = label.startsWith('loser') ? winner : loser
    const familyData = projectionFrom(alreadyProjected)
    store.commitBabyInfo({
      kind: 'reconcile', familyId: 'family-A',
      discoveredMutations: [reconciling],
      exactAcknowledgedMutationKeys: [getBabyInfoMutationKey(reconciling)],
    })

    await sync.reconcileFamilyBabyInfo(await options(familyData))

    expect(firestore.documents.get('families/family-A')).toMatchObject(projectionFrom(winner))
  })

  it('rejects a mutation whose updatedAt is a syntactically valid but non-existent calendar date', async () => {
    const { canonicalBabyInfoMutationJson } = await import('../shared/babyInfoResolver')
    const poisoned = mutation(800, { babyName: 'Bogus date', updatedAt: '2026-02-30T10:00:00.000Z' })

    expect(() => canonicalBabyInfoMutationJson(poisoned)).toThrow()
    // Date.parse alone silently rolls Feb 30 into Mar 2, so this proves the
    // explicit calendar check -- not just the ISO regex -- rejects it.
    expect(Number.isFinite(Date.parse(poisoned.updatedAt))).toBe(true)
  })

  it('rejects a cloud mutation whose numeric updatedAtMs shadow does not match its updatedAt string', async () => {
    const sync = await import('../src/sync/babyInfoSync')
    const base = mutation(820, { babyName: 'Shadow mismatch' })
    const poisoned = { ...base, updatedAtMs: Date.parse(base.updatedAt) + 1 }

    expect(sync.parseCloudBabyInfoDocument(sync.makeBabyInfoDocId(base), { mutation: poisoned }, 'family-A'))
      .toBeNull()
  })

  it('rejects a cloud mutation whose numeric shadow is far in the future', async () => {
    const sync = await import('../src/sync/babyInfoSync')
    const futureMs = Date.now() + 10 * 60 * 1000
    const base = mutation(830, { babyName: 'Future shadow', updatedAt: new Date(futureMs).toISOString() })
    const poisoned = { ...base, updatedAtMs: futureMs }

    expect(sync.parseCloudBabyInfoDocument(sync.makeBabyInfoDocId(poisoned), { mutation: poisoned }, 'family-A'))
      .toBeNull()
  })

  it('rejects a cloud document whose id does not match its content-bound hash', async () => {
    const sync = await import('../src/sync/babyInfoSync')
    const real = mutation(840, { babyName: 'Real content' })
    const forgedId = `b1|${real.mutationId}|30000000-0000-5000-8000-000000000841`
    expect(forgedId).not.toBe(sync.makeBabyInfoDocId(real))

    expect(sync.parseCloudBabyInfoDocument(forgedId, { mutation: real }, 'family-A')).toBeNull()
  })

  it('keeps two cloud mutations that reuse the same mutationId with different payloads as distinct entries', async () => {
    const sync = await import('../src/sync/babyInfoSync')
    const shared = '30000000-0000-4000-8000-000000000850'
    const first = mutation(850, { mutationId: shared, babyName: 'First payload', logicalClock: 100 })
    const second = mutation(851, { mutationId: shared, babyName: 'Second payload', logicalClock: 200 })
    expect(sync.makeBabyInfoDocId(first)).not.toBe(sync.makeBabyInfoDocId(second))
    firestore.documents.set(`families/family-A/babyInfoMutations/${sync.makeBabyInfoDocId(first)}`, { mutation: first })
    firestore.documents.set(`families/family-A/babyInfoMutations/${sync.makeBabyInfoDocId(second)}`, { mutation: second })

    const result = await sync.reconcileFamilyBabyInfo(await options())

    expect(result.needsRetry).toBe(false)
    expect(store.getBabyInfoSummary('family-A')).toMatchObject({ mutationCount: 2, winner: second })
  })

  it('isolates a poisoned cloud sibling from a valid one discovered in the same page', async () => {
    const sync = await import('../src/sync/babyInfoSync')
    const valid = mutation(810, { babyName: 'Valid sibling' })
    firestore.documents.set(`families/family-A/babyInfoMutations/${sync.makeBabyInfoDocId(valid)}`, { mutation: valid })
    const poisonMutationId = '30000000-0000-4000-8000-000000000811'
    const poisonDocId = `b1|${poisonMutationId}|30000000-0000-5000-8000-000000000812`
    firestore.documents.set(`families/family-A/babyInfoMutations/${poisonDocId}`, {
      mutation: {
        ...mutation(811, { mutationId: poisonMutationId }),
        updatedAt: '2026-02-30T10:00:00.000Z',
      },
    })

    const result = await sync.reconcileFamilyBabyInfo(await options())

    expect(result.needsRetry).toBe(false)
    expect(store.getBabyInfoSummary('family-A')).toMatchObject({ mutationCount: 1, winner: valid })
    expect(result.legacyClientUpdateRequired).toBe(false)
  })
})

describe('bilingual update-required copy', () => {
  it('ko.json explains that an older device must update before family sync resumes', async () => {
    const ko = await import('../src/i18n/ko.json')
    expect((ko as any).settings.babyInfoUpdateRequired).toContain('업데이트')
  })

  it('ja.json explains that an older device must update before family sync resumes', async () => {
    const ja = await import('../src/i18n/ja.json')
    expect((ja as any).settings.babyInfoUpdateRequired).toContain('更新')
  })
})
