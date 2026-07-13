import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../electron/store/settings'
import { BABY_INFO_JOURNAL_FILE, BabyInfoJournal } from '../electron/store/babyInfoJournal'
import type { DurableFileOps } from '../electron/store/durableFs'
import type {
  AppSettings,
  BabyInfoMutation,
  BabyInfoSettingsCommitResult,
} from '../shared/types'
import { getBabyInfoMutationKey } from '../shared/babyInfoResolver'

function baseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    baby: { name: 'Before', birthdate: '2026-01-01', gender: 'girl' },
    profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
    familyId: 'family-A',
    firebase: null,
    language: 'ko',
    theme: 'light',
    ...overrides,
  }
}

function mutation(index: number, familyId = 'family-A'): BabyInfoMutation {
  return {
    mutationId: `20000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    familyId,
    babyName: `Mutation ${index}`,
    babyBirthdate: '2026-02-02',
    logicalClock: index,
    updatedAt: `2026-07-13T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    authorId: 'user-1',
    origin: 'user',
  }
}

function writeSettings(tmpDir: string, settings: AppSettings): void {
  fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
}

function commit(
  store: SettingsStore,
  operation: unknown,
): BabyInfoSettingsCommitResult {
  return (store as SettingsStore & {
    commitBabyInfo(value: unknown): BabyInfoSettingsCommitResult
  }).commitBabyInfo(operation)
}

function listPending(store: SettingsStore, familyId = 'family-A', limit = 100) {
  return (store as SettingsStore & {
    listPendingBabyInfo(value: { familyId: string; limit: number }): {
      items: BabyInfoMutation[]
      nextCursor?: string
    }
  }).listPendingBabyInfo({ familyId, limit })
}

describe('SettingsStore main-owned baby-info journal integration', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-settings-journal-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('generic full save cannot modify the current pair, journal metadata, or revision even at the current revision', () => {
    const staleWinnerKey = getBabyInfoMutationKey(mutation(901))
    writeSettings(tmpDir, baseSettings())
    const store = new SettingsStore(tmpDir)
    const current = store.get()

    const saved = store.save({
      ...current,
      baby: { ...current.baby, name: 'Generic overwrite', birthdate: '2030-12-31' },
      babyInfoRevision: current.babyInfoRevision,
      babyInfoJournal: {
        version: 1,
        projectedFamilyId: 'family-foreign',
        projectedWinnerKey: staleWinnerKey,
      },
      theme: 'dark',
    })

    expect(saved.theme).toBe('dark')
    expect(saved.baby).toMatchObject({ name: current.baby.name, birthdate: current.baby.birthdate })
    expect(saved.babyInfoRevision).toBe(current.babyInfoRevision)
    expect(saved.babyInfoJournal).toEqual(current.babyInfoJournal)
  })

  it('generic partial merge cannot modify managed fields even with a fresh revision', () => {
    writeSettings(tmpDir, baseSettings())
    const store = new SettingsStore(tmpDir)
    const current = store.get()

    const saved = store.merge({
      baby: { name: 'Merge overwrite', birthdate: '2031-01-01' },
      babyInfoRevision: current.babyInfoRevision,
      theme: 'dark',
    })

    expect(saved.theme).toBe('dark')
    expect(saved.baby).toMatchObject({ name: current.baby.name, birthdate: current.baby.birthdate })
    expect(saved.babyInfoRevision).toBe(current.babyInfoRevision)
  })

  it('imports legacy babyInfoSync durably once, then removes only the now-durable source', () => {
    const pending = mutation(1)
    const acknowledged = mutation(2)
    writeSettings(tmpDir, baseSettings({
      babyInfoSync: {
        version: 1,
        mutations: [pending, acknowledged],
        pendingMutationKeys: [getBabyInfoMutationKey(pending)],
      },
    }))

    const first = new SettingsStore(tmpDir)
    expect(first.get().babyInfoSync).toBeUndefined()
    expect(first.get().babyInfoJournal).toMatchObject({
      version: 1,
      projectedFamilyId: 'family-A',
    })
    expect(listPending(first).items).toEqual([pending])

    const journalBefore = fs.readFileSync(path.join(tmpDir, 'baby-info-journal-v1.jsonl'), 'utf8')
    const restarted = new SettingsStore(tmpDir)
    expect(listPending(restarted).items).toEqual([pending])
    expect(fs.readFileSync(path.join(tmpDir, 'baby-info-journal-v1.jsonl'), 'utf8')).toBe(journalBefore)
  })

  it('keeps the legacy source on disk when the sidecar import cannot become durable', () => {
    const pending = mutation(3)
    const settings = baseSettings({
      babyInfoSync: {
        version: 1,
        mutations: [pending],
        pendingMutationKeys: [getBabyInfoMutationKey(pending)],
      },
    })
    writeSettings(tmpDir, settings)
    fs.mkdirSync(path.join(tmpDir, 'baby-info-journal-v1.jsonl'))

    expect(() => new SettingsStore(tmpDir)).toThrow()
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8')).babyInfoSync)
      .toEqual(settings.babyInfoSync)
  })

  it('journals and fsyncs a user edit before returning a bounded settings projection', () => {
    writeSettings(tmpDir, baseSettings())
    const store = new SettingsStore(tmpDir)

    const result = commit(store, {
      kind: 'user-edit',
      familyId: 'family-A',
      babyName: 'After',
      babyBirthdate: '2026-03-03',
    })

    expect(result.babyInfo).toBe('pending')
    expect(result.settings.baby).toMatchObject({ name: 'After', birthdate: '2026-03-03' })
    expect(result.settings.babyInfoSync).toBeUndefined()
    expect(result.settings.babyInfoJournal).toMatchObject({
      version: 1,
      projectedFamilyId: 'family-A',
      projectedWinnerKey: getBabyInfoMutationKey(result.mutation!),
    })
    expect(listPending(store).items).toContainEqual(result.mutation)
    expect(JSON.stringify(result).length).toBeLessThan(20_000)
  })

  it('applies page-sized discovered and exact-ack deltas without returning history', () => {
    writeSettings(tmpDir, baseSettings())
    const store = new SettingsStore(tmpDir)
    const discovered = Array.from({ length: 250 }, (_, index) => mutation(index + 10))
    const acknowledged = discovered.slice(0, 200).map(getBabyInfoMutationKey)

    const result = commit(store, {
      kind: 'reconcile',
      familyId: 'family-A',
      discoveredMutations: discovered,
      exactAcknowledgedMutationKeys: acknowledged,
    })

    expect(result.pendingCount).toBeGreaterThanOrEqual(50)
    expect(result.activePendingCount).toBeGreaterThanOrEqual(50)
    expect(result.settings.babyInfoSync).toBeUndefined()
    expect(JSON.stringify(result).length).toBeLessThan(20_000)
    expect(listPending(store, 'family-A', 500).items).toHaveLength(result.activePendingCount)
  })

  it('recovers the winner projection after a crash between journal fsync and settings replacement', () => {
    const old = baseSettings({ babyInfoRevision: 4 })
    writeSettings(tmpDir, old)
    const journal = new BabyInfoJournal(tmpDir)
    const durable = mutation(400)
    journal.ingest('family-A', [durable], [])

    const restarted = new SettingsStore(tmpDir)

    expect(restarted.get().baby).toMatchObject({
      name: durable.babyName,
      birthdate: durable.babyBirthdate,
    })
    expect(restarted.get().babyInfoRevision).toBeGreaterThan(4)
    expect(restarted.get().babyInfoJournal?.projectedWinnerKey).toBe(getBabyInfoMutationKey(durable))
  })

  it('does not publish an in-memory settings projection when settings replacement fails after journaling', () => {
    writeSettings(tmpDir, baseSettings())
    const store = new SettingsStore(tmpDir)
    const before = store.get()
    const settingsPath = path.join(tmpDir, 'settings.json')
    fs.rmSync(settingsPath)
    fs.mkdirSync(settingsPath)

    let failure: unknown
    try { commit(store, {
      kind: 'user-edit',
      familyId: 'family-A',
      babyName: 'Durable but not projected',
      babyBirthdate: '2026-04-04',
    }) } catch (error) { failure = error }
    expect(failure).toMatchObject({
      code: 'SETTINGS_RECOVERY_REQUIRED',
      localDataModified: true,
      readOnly: true,
      journalEvidence: { kind: 'user-edit', durable: true },
    })
    expect(store.get()).toEqual(before)
    const journalAfterFailure = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))
    expect(() => listPending(store)).toThrow(expect.objectContaining({
      code: 'SETTINGS_RECOVERY_REQUIRED',
    }))
    expect(() => commit(store, {
      kind: 'user-edit',
      familyId: 'family-A',
      babyName: 'Must remain blocked',
      babyBirthdate: '2026-05-05',
    })).toThrow(expect.objectContaining({ code: 'SETTINGS_RECOVERY_REQUIRED' }))
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(journalAfterFailure)

    fs.rmSync(settingsPath, { recursive: true, force: true })
    writeSettings(tmpDir, before)
    expect(new SettingsStore(tmpDir).get().baby.name).toBe('Durable but not projected')
  })

  it('locks after reconcile journaling becomes durable but its projection replacement fails', () => {
    writeSettings(tmpDir, baseSettings())
    let failProjection = false
    const settingsPath = path.join(tmpDir, 'settings.json')
    const durableFs = Object.create(fs) as DurableFileOps
    durableFs.renameSync = (oldPath, newPath) => {
      if (failProjection && path.resolve(String(newPath)) === path.resolve(settingsPath)) {
        throw Object.assign(new Error('injected reconcile projection failure'), { code: 'EIO' })
      }
      fs.renameSync(oldPath, newPath)
    }
    const store = new SettingsStore(tmpDir, { durableFs })
    const discovered = mutation(906)
    failProjection = true

    let failure: unknown
    try {
      commit(store, {
        kind: 'reconcile',
        familyId: 'family-A',
        discoveredMutations: [discovered],
        exactAcknowledgedMutationKeys: [],
      })
    } catch (error) { failure = error }
    expect(failure).toMatchObject({
      code: 'SETTINGS_RECOVERY_REQUIRED',
      localDataModified: true,
      readOnly: true,
      journalEvidence: { kind: 'reconcile', durable: true },
    })
    const journalAfterFailure = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))
    expect(() => listPending(store)).toThrow(expect.objectContaining({
      code: 'SETTINGS_RECOVERY_REQUIRED',
    }))
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(journalAfterFailure)

    const restarted = new SettingsStore(tmpDir)
    expect(restarted.get().baby).toMatchObject({
      name: discovered.babyName,
      birthdate: discovered.babyBirthdate,
    })
    expect(restarted.getBabyInfoSummary('family-A').winner).toEqual(discovered)
  })

  it('locks SettingsStore when a user-edit journal append commits but close fails', () => {
    writeSettings(tmpDir, baseSettings())
    const targets = new Map<number, { path: string; flags: fs.OpenMode }>()
    const realOpen = fs.openSync.bind(fs)
    let failJournalClose = false
    let failedClose = false
    let writeCalls = 0
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target, flags, mode) {
        const fd = realOpen(target, flags, mode)
        targets.set(fd, { path: String(target), flags })
        return fd
      },
      writeSync(fd, buffer, offset, length, position) {
        writeCalls += 1
        return fs.writeSync(fd, buffer, offset, length, position)
      },
      closeSync(fd) {
        const target = targets.get(fd)
        targets.delete(fd)
        fs.closeSync(fd)
        if (failJournalClose
          && !failedClose
          && target?.path.endsWith(BABY_INFO_JOURNAL_FILE)
          && target.flags === 'r+') {
          failedClose = true
          throw new Error('injected committed journal close failure')
        }
      },
    }
    const store = new SettingsStore(tmpDir, { durableFs })
    failJournalClose = true

    let failure: unknown
    try {
      commit(store, {
        kind: 'user-edit',
        familyId: 'family-A',
        babyName: 'Committed journal suffix',
        babyBirthdate: '2026-06-06',
      })
    } catch (error) { failure = error }
    expect(failure).toMatchObject({
      code: 'SETTINGS_RECOVERY_REQUIRED',
      localDataModified: true,
      readOnly: true,
      journalEvidence: {
        kind: 'storage-uncertain',
        durable: true,
        committed: true,
        uncertain: true,
      },
    })
    const writesAfterFailure = writeCalls
    expect(() => listPending(store)).toThrow(expect.objectContaining({
      code: 'SETTINGS_RECOVERY_REQUIRED',
    }))
    expect(() => store.save(store.get())).toThrow(expect.objectContaining({
      code: 'SETTINGS_RECOVERY_REQUIRED',
    }))
    expect(() => commit(store, {
      kind: 'user-edit',
      familyId: 'family-A',
      babyName: 'Blocked',
      babyBirthdate: '2026-07-07',
    })).toThrow(expect.objectContaining({ code: 'SETTINGS_RECOVERY_REQUIRED' }))
    expect(writeCalls).toBe(writesAfterFailure)

    const restarted = new SettingsStore(tmpDir)
    expect(restarted.get().baby).toMatchObject({
      name: 'Committed journal suffix',
      birthdate: '2026-06-06',
    })
  })

  it('reports and replays a legacy import whose journal append committed before close failed', () => {
    const pending = mutation(907)
    writeSettings(tmpDir, baseSettings({
      babyInfoSync: {
        version: 1,
        mutations: [pending],
        pendingMutationKeys: [getBabyInfoMutationKey(pending)],
      },
    }))
    fs.writeFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE), '')
    const targets = new Map<number, { path: string; flags: fs.OpenMode }>()
    const realOpen = fs.openSync.bind(fs)
    let failedClose = false
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target, flags, mode) {
        const fd = realOpen(target, flags, mode)
        targets.set(fd, { path: String(target), flags })
        return fd
      },
      closeSync(fd) {
        const target = targets.get(fd)
        targets.delete(fd)
        fs.closeSync(fd)
        if (!failedClose
          && target?.path.endsWith(BABY_INFO_JOURNAL_FILE)
          && target.flags === 'r+') {
          failedClose = true
          throw new Error('injected legacy journal close failure')
        }
      },
    }

    let failure: unknown
    try { new SettingsStore(tmpDir, { durableFs }) } catch (error) { failure = error }
    expect(failure).toMatchObject({
      code: 'SETTINGS_RECOVERY_REQUIRED',
      localDataModified: true,
      readOnly: true,
      journalEvidence: {
        kind: 'storage-uncertain',
        durable: true,
        committed: true,
        uncertain: true,
      },
    })
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8')).babyInfoSync)
      .toBeDefined()
    expect(new BabyInfoJournal(tmpDir).getSummary('family-A')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: pending,
    })

    const restarted = new SettingsStore(tmpDir)
    expect(restarted.get().babyInfoSync).toBeUndefined()
    expect(restarted.getBabyInfoSummary('family-A')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: pending,
    })
  })

  it('isolates projections across A -> B -> restart and restores A when switching back', () => {
    writeSettings(tmpDir, baseSettings())
    const store = new SettingsStore(tmpDir)
    const familyAWinner = store.getBabyInfoSummary('family-A').winner
    expect(familyAWinner?.babyName).toBe('Before')

    const switched = store.merge({ familyId: 'family-B' })
    expect(switched.familyId).toBe('family-B')
    expect(switched.baby).toMatchObject({ name: '', birthdate: '' })
    expect(switched.babyInfoJournal).toEqual({
      version: 1,
      projectedFamilyId: 'family-B',
      projectedWinnerKey: undefined,
    })

    const restarted = new SettingsStore(tmpDir)
    expect(restarted.get().baby).toMatchObject({ name: '', birthdate: '' })
    expect(restarted.getBabyInfoSummary('family-B').mutationCount).toBe(0)

    const returned = restarted.merge({ familyId: 'family-A' })
    expect(returned.baby).toMatchObject({
      name: familyAWinner!.babyName,
      birthdate: familyAWinner!.babyBirthdate,
    })
    expect(returned.babyInfoJournal?.projectedWinnerKey)
      .toBe(getBabyInfoMutationKey(familyAWinner!))
  })

  it('projects an existing destination winner and clears the pair for an empty destination', () => {
    writeSettings(tmpDir, baseSettings())
    const familyBWinner = mutation(700, 'family-B')
    new BabyInfoJournal(tmpDir).ingest('family-B', [familyBWinner], [])
    const store = new SettingsStore(tmpDir)

    expect(store.merge({ familyId: 'family-B' }).baby).toMatchObject({
      name: familyBWinner.babyName,
      birthdate: familyBWinner.babyBirthdate,
    })
    expect(store.merge({ familyId: '' }).baby).toMatchObject({ name: '', birthdate: '' })
    expect(store.get().babyInfoJournal).toEqual({
      version: 1,
      projectedFamilyId: '',
      projectedWinnerKey: undefined,
    })
  })

  it('bootstraps a pair only for a truly pre-journal settings file', () => {
    writeSettings(tmpDir, baseSettings())

    const migrated = new SettingsStore(tmpDir)

    expect(migrated.getBabyInfoSummary('family-A')).toMatchObject({
      mutationCount: 1,
      winner: expect.objectContaining({
        babyName: 'Before',
        babyBirthdate: '2026-01-01',
        origin: 'legacy-local',
      }),
    })
    expect(new SettingsStore(tmpDir).getBabyInfoSummary('family-A').mutationCount).toBe(1)
  })

  it('archives an unscoped legacy pair once and never adopts it through create or join', () => {
    writeSettings(tmpDir, baseSettings({
      familyId: '',
      baby: { name: 'Local draft', birthdate: '2026-05-05', gender: 'girl' },
    }))
    const createStore = new SettingsStore(tmpDir)

    expect(createStore.get().baby).toMatchObject({ name: '', birthdate: '' })
    expect(createStore.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toEqual([
      expect.objectContaining({
        babyName: 'Local draft',
        babyBirthdate: '2026-05-05',
        source: 'legacy-unscoped',
      }),
    ])
    expect(new SettingsStore(tmpDir).listUnlinkedBabyInfoArchives({ limit: 10 }).items).toHaveLength(1)

    const created = commit(createStore, {
      kind: 'family-transition',
      familyId: 'family-created',
      mode: 'create',
    })

    expect(created.settings.baby).toMatchObject({ name: '', birthdate: '' })
    expect(created.activePendingCount).toBe(0)
    expect(created.mutation).toBeUndefined()
    expect(createStore.getBabyInfoSummary('family-created').mutationCount).toBe(0)
    expect(createStore.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toHaveLength(1)

    const joinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-settings-join-'))
    try {
      writeSettings(joinDir, baseSettings({
        familyId: '',
        baby: { name: 'Must not join', birthdate: '2025-01-01', gender: 'boy' },
      }))
      const joinStore = new SettingsStore(joinDir)
      expect(joinStore.get().baby).toMatchObject({ name: '', birthdate: '' })
      expect(joinStore.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toHaveLength(1)
      const joined = commit(joinStore, {
        kind: 'family-transition',
        familyId: 'family-existing',
        mode: 'join',
      })

      expect(joined.settings.baby).toMatchObject({ name: '', birthdate: '' })
      expect(joined.activePendingCount).toBe(0)
      expect(joinStore.getBabyInfoSummary('family-existing').mutationCount).toBe(0)
      expect(joinStore.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toHaveLength(1)
    } finally {
      fs.rmSync(joinDir, { recursive: true, force: true })
    }
  })

  it('reports durable archive evidence when projection replacement fails after the archive append', () => {
    writeSettings(tmpDir, baseSettings({
      familyId: '',
      baby: { name: 'Archive before failure', birthdate: '2026-05-06', gender: 'girl' },
    }))
    const settingsPath = path.join(tmpDir, 'settings.json')
    const durableFs = Object.create(fs) as DurableFileOps
    durableFs.renameSync = (oldPath, newPath) => {
      if (path.resolve(String(newPath)) === path.resolve(settingsPath)) {
        throw Object.assign(new Error('injected projection replacement failure'), { code: 'EIO' })
      }
      fs.renameSync(oldPath, newPath)
    }

    let failure: unknown
    try {
      new SettingsStore(tmpDir, { durableFs })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      code: 'SETTINGS_RECOVERY_REQUIRED',
      localDataModified: true,
      readOnly: true,
      restartRequired: true,
      archiveEvidence: {
        archiveId: expect.any(String),
        durable: true,
      },
    })
    expect(new BabyInfoJournal(tmpDir).listUnlinkedArchivePage({ limit: 10 }).items).toEqual([
      expect.objectContaining({
        babyName: 'Archive before failure',
        babyBirthdate: '2026-05-06',
      }),
    ])

    const restarted = new SettingsStore(tmpDir)
    expect(restarted.get().baby).toMatchObject({ name: '', birthdate: '' })
    expect(restarted.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toHaveLength(1)
  })

  it('replays an unlinked archive whose journal append committed before close failed', () => {
    writeSettings(tmpDir, baseSettings({
      familyId: '',
      baby: { name: 'Archive committed before close', birthdate: '2026-08-08', gender: 'girl' },
    }))
    fs.writeFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE), '')
    const targets = new Map<number, { path: string; flags: fs.OpenMode }>()
    const realOpen = fs.openSync.bind(fs)
    let failedClose = false
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target, flags, mode) {
        const fd = realOpen(target, flags, mode)
        targets.set(fd, { path: String(target), flags })
        return fd
      },
      closeSync(fd) {
        const target = targets.get(fd)
        targets.delete(fd)
        fs.closeSync(fd)
        if (!failedClose
          && target?.path.endsWith(BABY_INFO_JOURNAL_FILE)
          && target.flags === 'r+') {
          failedClose = true
          throw new Error('injected unlinked archive close failure')
        }
      },
    }

    let failure: unknown
    try { new SettingsStore(tmpDir, { durableFs }) } catch (error) { failure = error }
    expect(failure).toMatchObject({
      code: 'SETTINGS_RECOVERY_REQUIRED',
      localDataModified: true,
      readOnly: true,
      restartRequired: true,
      journalEvidence: {
        kind: 'storage-uncertain',
        durable: true,
        committed: true,
        uncertain: true,
      },
    })
    expect(new BabyInfoJournal(tmpDir).listUnlinkedArchivePage({ limit: 10 }).items).toEqual([
      expect.objectContaining({
        babyName: 'Archive committed before close',
        babyBirthdate: '2026-08-08',
      }),
    ])

    const restarted = new SettingsStore(tmpDir)
    expect(restarted.get().baby).toMatchObject({ name: '', birthdate: '' })
    expect(restarted.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toHaveLength(1)
  })

  it('reports durable linked legacy migration evidence when settings projection fails', () => {
    const pending = mutation(905)
    writeSettings(tmpDir, baseSettings({
      babyInfoSync: {
        version: 1,
        mutations: [pending],
        pendingMutationKeys: [getBabyInfoMutationKey(pending)],
      },
    }))
    const settingsPath = path.join(tmpDir, 'settings.json')
    const durableFs = Object.create(fs) as DurableFileOps
    durableFs.renameSync = (oldPath, newPath) => {
      if (path.resolve(String(newPath)) === path.resolve(settingsPath)) {
        throw Object.assign(new Error('injected linked migration projection failure'), { code: 'EIO' })
      }
      fs.renameSync(oldPath, newPath)
    }

    let failure: unknown
    try {
      new SettingsStore(tmpDir, { durableFs })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      code: 'SETTINGS_RECOVERY_REQUIRED',
      localDataModified: true,
      journalEvidence: {
        kind: 'legacy-import',
        durable: true,
      },
    })
    const journal = new BabyInfoJournal(tmpDir)
    expect(journal.getSummary('family-A')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: pending,
    })
    const journalBeforeRestart = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))

    const restarted = new SettingsStore(tmpDir)
    expect(restarted.get().babyInfoSync).toBeUndefined()
    expect(restarted.getBabyInfoSummary('family-A')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: pending,
    })
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(journalBeforeRestart)
  })

  it('does not create an archive or cloud pending record for a blank unscoped pair', () => {
    writeSettings(tmpDir, baseSettings({
      familyId: '',
      baby: { name: '', birthdate: '', gender: 'girl' },
    }))

    const store = new SettingsStore(tmpDir)
    expect(store.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toEqual([])

    const created = commit(store, {
      kind: 'family-transition',
      familyId: 'family-created',
      mode: 'create',
    })
    expect(created).toMatchObject({ activePendingCount: 0, pendingCount: 0 })
    expect(store.getBabyInfoSummary('family-created').mutationCount).toBe(0)
  })

  it('archives an old-family pair after familyId is lost and keeps destination C blank', () => {
    writeSettings(tmpDir, baseSettings())
    const linked = new SettingsStore(tmpDir)
    expect(linked.getBabyInfoSummary('family-A').mutationCount).toBe(1)

    const unscoped = linked.get()
    writeSettings(tmpDir, {
      ...unscoped,
      familyId: '',
      babyInfoJournal: undefined,
      baby: { ...unscoped.baby, name: 'Former A', birthdate: '2026-01-01' },
    })

    const upgraded = new SettingsStore(tmpDir)
    expect(upgraded.get().baby).toMatchObject({ name: '', birthdate: '' })
    expect(upgraded.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toEqual([
      expect.objectContaining({ babyName: 'Former A', babyBirthdate: '2026-01-01' }),
    ])

    const created = commit(upgraded, {
      kind: 'family-transition',
      familyId: 'family-C',
      mode: 'create',
    })
    expect(created.settings.baby).toMatchObject({ name: '', birthdate: '' })
    expect(created.activePendingCount).toBe(0)
    expect(upgraded.getBabyInfoSummary('family-C').mutationCount).toBe(0)
  })

  it('retains the unlinked archive when a create projection write crashes', () => {
    const initial = baseSettings({
      familyId: '',
      baby: { name: 'Crash-safe local', birthdate: '2026-06-06', gender: 'girl' },
    })
    writeSettings(tmpDir, initial)
    const store = new SettingsStore(tmpDir)
    const before = store.get()
    const settingsPath = path.join(tmpDir, 'settings.json')
    fs.rmSync(settingsPath)
    fs.mkdirSync(settingsPath)

    expect(() => commit(store, {
      kind: 'family-transition',
      familyId: 'family-created',
      mode: 'create',
    })).toThrow()

    fs.rmSync(settingsPath, { recursive: true, force: true })
    writeSettings(tmpDir, before)
    const restarted = new SettingsStore(tmpDir)
    const recovered = restarted.merge({ familyId: 'family-created' })
    expect(recovered.baby).toMatchObject({ name: '', birthdate: '' })
    expect(restarted.getBabyInfoSummary('family-created').mutationCount).toBe(0)
    expect(restarted.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toEqual([
      expect.objectContaining({
        babyName: 'Crash-safe local',
        babyBirthdate: '2026-06-06',
      }),
    ])
  })
})
