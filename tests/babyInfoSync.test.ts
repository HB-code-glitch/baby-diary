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

  it('turns a v0.3.8 pair-only family update into a deterministic bridge bound to the prior winner', async () => {
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

    await sync.reconcileFamilyBabyInfo(await options(familyData))
    const firstWinner = store.getBabyInfoSummary('family-A').winner!
    expect(firstWinner).toMatchObject({
      babyName: 'Old client edit',
      babyBirthdate: '2026-05-05',
      logicalClock: 11,
      origin: 'legacy-cloud',
    })
    expect(store.getBabyInfoSummary('family-A').pendingCount).toBe(0)

    // Replaying the same old-client projection in the opposite device order
    // deduplicates the deterministic bridge and cannot revert the winner.
    await sync.reconcileFamilyBabyInfo(await options(familyData))
    expect(store.getBabyInfoSummary('family-A').winner).toEqual(firstWinner)
    expect(store.getBabyInfoSummary('family-A').mutationCount).toBe(2)
  })

  it('propagates an initial paged read failure even when there were zero local pending items', async () => {
    installStore(tmpDir, baseSettings({ baby: { name: '', birthdate: '' } }))
    firestore.failGetDocs = 1
    const sync = await import('../src/sync/babyInfoSync')

    await expect(sync.reconcileFamilyBabyInfo(await options())).rejects.toMatchObject({ code: 'unavailable' })
    expect(store.getBabyInfoSummary('family-A').pendingCount).toBe(0)
  })
})
