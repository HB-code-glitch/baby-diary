import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { SettingsStore } from '../electron/store/settings'
import type { DurableFileOps } from '../electron/store/durableFs'
import { AppSettings, BabyInfoMutation, BabyInfoSettingsCommitResult } from '../shared/types'
import { getBabyInfoMutationKey } from '../shared/babyInfoResolver'

function simulatedPosixOps(): DurableFileOps {
  const realOpen = fs.openSync.bind(fs)
  const directoryFds = new Set<number>()
  let nextDirectoryFd = -1000
  return {
    ...fs,
    openSync(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        const fd = nextDirectoryFd--
        directoryFds.add(fd)
        return fd
      }
      return realOpen(target, flags, mode)
    },
    fsyncSync(fd) {
      if (directoryFds.has(fd)) return
      fs.fsyncSync(fd)
    },
    closeSync(fd) {
      if (directoryFds.delete(fd)) return
      fs.closeSync(fd)
    },
  }
}

describe('SettingsStore', () => {
  let tmpDir: string
  let store: SettingsStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-diary-settings-test-'))
    store = new SettingsStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('atomic generic write saves ordinary settings without changing the main-owned baby pair', () => {
    const settings: AppSettings = {
      baby: { name: '아기', birthdate: '2024-01-01' },
      profile: { uid: 'uid1', name: '아빠', role: 'dad' },
      familyId: 'family1',
      firebase: null,
    }

    store.save(settings)

    const store2 = new SettingsStore(tmpDir)
    const loaded = store2.get()

    expect(loaded.baby).toMatchObject({ name: '', birthdate: '' })
    expect(loaded.profile.role).toBe('dad')
    expect(loaded.familyId).toBe('family1')
  })

  it('no tmp file left after save', () => {
    const settings: AppSettings = {
      baby: { name: '테스트', birthdate: '2024-06-01' },
      profile: { uid: 'uid2', name: '엄마', role: 'mom' },
      familyId: '',
      firebase: null,
    }

    store.save(settings)

    const files = fs.readdirSync(tmpDir)
    const tmpFiles = files.filter(f => f.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)

    const settingsFile = files.find(f => f === 'settings.json')
    expect(settingsFile).toBeDefined()
  })

  it('round-trips a committed durable baby-info log and exact pending identity', () => {
    const mutation: BabyInfoMutation = {
      mutationId: '10000000-0000-4000-8000-000000000001',
      familyId: 'family1',
      babyName: '',
      babyBirthdate: '',
      logicalClock: 1,
      updatedAt: '2026-07-13T01:02:03.000Z',
      authorId: 'uid1',
      origin: 'user',
    }
    const settings: AppSettings = {
      baby: { name: '', birthdate: '' },
      profile: { uid: 'uid1', name: '아빠', role: 'dad' },
      familyId: 'family1',
      firebase: null,
    }

    store.save(settings)
    const committed = store.commitBabyInfo({
      kind: 'reconcile',
      familyId: 'family1',
      discoveredMutations: [mutation],
      exactAcknowledgedMutationKeys: [],
    })

    const restarted = new SettingsStore(tmpDir)
    expect(restarted.get().babyInfoSync).toBeUndefined()
    expect(restarted.getBabyInfoSummary('family1')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: mutation,
    })
    expect(restarted.listPendingBabyInfo({ familyId: 'family1', limit: 10 }).items)
      .toEqual([mutation])
    expect(committed.activePendingCount).toBe(1)
  })

  // ── BOM handling ────────────────────────────────────────────────────────────

  it('BOM read: loads settings.json that has a UTF-8 BOM prefix', () => {
    const settings: AppSettings = {
      baby: { name: 'BOM아기', birthdate: '2024-03-01' },
      profile: { uid: 'bom-uid', name: 'BOM엄마', role: 'mom' },
      familyId: 'bom-family',
      firebase: null,
    }
    // Write with BOM manually
    const json = '﻿' + JSON.stringify(settings, null, 2)
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), json, 'utf-8')

    const loaded = new SettingsStore(tmpDir, {
      platform: 'linux',
      durableFs: simulatedPosixOps(),
    }).get()
    expect(loaded.baby.name).toBe('BOM아기')
    expect(loaded.profile.uid).toBe('bom-uid')
    expect(loaded.familyId).toBe('bom-family')
  })

  // ── Corrupt settings + backup restore ──────────────────────────────────────

  it('corrupt settings.json: writes a forensic archive and fails closed when no verified backup exists', () => {
    // Write garbage JSON
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ not valid json !!!', 'utf-8')

    expect(() => new SettingsStore(tmpDir)).toThrow(expect.objectContaining({
      code: 'SETTINGS_RECOVERY_REQUIRED',
    }))

    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    const archives = fs.readdirSync(forensicRoot)
    expect(archives).toHaveLength(1)
    const manifest = JSON.parse(fs.readFileSync(
      path.join(forensicRoot, archives[0], 'manifest.json'),
      'utf8',
    ))
    expect(manifest).toMatchObject({ source: 'baby-diary-recovery' })
  })

  it('corrupt settings.json: restores from newest backup snapshot', () => {
    const goodSettings: AppSettings = {
      baby: { name: '복구아기', birthdate: '2025-01-01' },
      profile: { uid: 'restore-uid', name: '복구엄마', role: 'mom' },
      familyId: 'restored-family',
      firebase: null,
    }

    // Create backups/2025-01-01T00-00-00/settings.json
    const backupDir = path.join(tmpDir, 'backups', '2025-01-01_00-00-00')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'settings.json'), JSON.stringify(goodSettings, null, 2), 'utf-8')

    // Write corrupt primary settings.json
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '}} totally broken {{', 'utf-8')

    const loaded = new SettingsStore(tmpDir, {
      platform: 'linux',
      durableFs: simulatedPosixOps(),
    }).get()
    expect(loaded.baby.name).toBe('복구아기')
    expect(loaded.familyId).toBe('restored-family')
    expect(loaded.profile.uid).toBe('restore-uid')
  })

  it('corrupt settings.json: uses newest backup when multiple exist', () => {
    const oldSettings: AppSettings = {
      baby: { name: '구버전아기', birthdate: '2024-01-01' },
      profile: { uid: 'old-uid', name: '구버전엄마', role: 'mom' },
      familyId: 'old-family',
      firebase: null,
    }
    const newSettings: AppSettings = {
      baby: { name: '최신아기', birthdate: '2025-06-01' },
      profile: { uid: 'new-uid', name: '최신아빠', role: 'dad' },
      familyId: 'new-family',
      firebase: null,
    }

    // Older backup
    const oldDir = path.join(tmpDir, 'backups', '2024-06-01_00-00-00')
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, 'settings.json'), JSON.stringify(oldSettings, null, 2), 'utf-8')

    // Newer backup (sorts after old lexicographically)
    const newDir = path.join(tmpDir, 'backups', '2025-06-01_00-00-00')
    fs.mkdirSync(newDir, { recursive: true })
    fs.writeFileSync(path.join(newDir, 'settings.json'), JSON.stringify(newSettings, null, 2), 'utf-8')

    // Corrupt primary
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), 'not json', 'utf-8')

    const loaded = new SettingsStore(tmpDir, {
      platform: 'linux',
      durableFs: simulatedPosixOps(),
    }).get()
    expect(loaded.baby.name).toBe('최신아기')
    expect(loaded.familyId).toBe('new-family')
  })

  describe('managed baby-info commits', () => {
    function initialSettings(): AppSettings {
      return {
        baby: { name: 'Before', birthdate: '2026-01-01' },
        profile: { uid: 'uid-main', name: 'Parent', role: 'mom' },
        familyId: 'family-main',
        firebase: null,
        language: 'ko',
      }
    }

    function commitUserEdit(
      target: SettingsStore,
      _next: AppSettings,
      name: string,
      birthdate: string,
    ): BabyInfoSettingsCommitResult {
      return target.commitBabyInfo({
        kind: 'user-edit',
        familyId: target.get().familyId,
        babyName: name,
        babyBirthdate: birthdate,
      })
    }

    function commitReconcile(
      target: SettingsStore,
      discoveredMutations: BabyInfoMutation[],
      exactAcknowledgedMutationKeys: string[],
    ): BabyInfoSettingsCommitResult {
      return target.commitBabyInfo({
        kind: 'reconcile',
        familyId: 'family-main',
        discoveredMutations,
        exactAcknowledgedMutationKeys,
      })
    }

    it('keeps the newest log, pending identity and pair across a stale full save', () => {
      store.save(initialSettings())
      const stale = store.get()
      const committed = commitUserEdit(
        store,
        { ...stale, baby: { ...stale.baby, name: 'Newest', birthdate: '2026-07-01' } },
        'Newest',
        '2026-07-01',
      )

      store.save({ ...stale, theme: 'dark' })

      const current = store.get()
      expect(current.theme).toBe('dark')
      expect(current.baby).toMatchObject({ name: 'Newest', birthdate: '2026-07-01' })
      expect(current.babyInfoSync).toBeUndefined()
      expect(current.babyInfoJournal).toEqual(committed.settings.babyInfoJournal)
      expect(current.babyInfoRevision).toBe(committed.settings.babyInfoRevision)
      expect(store.getBabyInfoSummary('family-main').pendingCount).toBe(1)
    })

    it('keeps managed baby info across a stale partial merge and an old renderer payload', () => {
      store.save(initialSettings())
      const stale = store.get()
      const committed = commitUserEdit(
        store,
        { ...stale, baby: { ...stale.baby, name: 'Managed', birthdate: '2026-07-02' } },
        'Managed',
        '2026-07-02',
      )
      const oldRenderer = { ...stale } as Partial<AppSettings>
      delete oldRenderer.babyInfoSync
      delete oldRenderer.babyInfoRevision

      store.merge({ ...oldRenderer, language: 'ja' })

      const current = store.get()
      expect(current.language).toBe('ja')
      expect(current.baby).toMatchObject({ name: 'Managed', birthdate: '2026-07-02' })
      expect(current.babyInfoSync).toBeUndefined()
      expect(current.babyInfoJournal).toEqual(committed.settings.babyInfoJournal)
      expect(current.babyInfoRevision).toBe(committed.settings.babyInfoRevision)
      expect(store.getBabyInfoSummary('family-main').pendingCount).toBe(1)
    })

    it('does not resurrect an acknowledged pending key from a stale generic save', () => {
      store.save(initialSettings())
      const staleBeforeCommit = store.get()
      const edited = commitUserEdit(
        store,
        { ...staleBeforeCommit, baby: { name: 'Acked', birthdate: '2026-07-03' } },
        'Acked',
        '2026-07-03',
      )
      const stalePending = edited.settings
      const key = getBabyInfoMutationKey(edited.mutation!)

      const reconciled = commitReconcile(store, [], [key])
      expect(reconciled.activePendingCount).toBe(0)

      store.save(stalePending)

      expect(store.get().babyInfoSync).toBeUndefined()
      expect(store.getBabyInfoSummary('family-main').pendingCount).toBe(0)
      expect(store.get().babyInfoRevision).toBe(reconciled.settings.babyInfoRevision)
    })

    it('persists the invariant across SettingsStore recreation', () => {
      store.save(initialSettings())
      const stale = store.get()
      const committed = commitUserEdit(
        store,
        { ...stale, baby: { name: 'Restart-safe', birthdate: '2026-07-04' } },
        'Restart-safe',
        '2026-07-04',
      )

      const restarted = new SettingsStore(tmpDir)
      restarted.save(stale)

      expect(new SettingsStore(tmpDir).get()).toMatchObject({
        baby: { name: 'Restart-safe', birthdate: '2026-07-04' },
        babyInfoJournal: committed.settings.babyInfoJournal,
        babyInfoRevision: committed.settings.babyInfoRevision,
      })
      expect(new SettingsStore(tmpDir).getBabyInfoSummary('family-main').pendingCount).toBe(1)
    })

    it('preserves both originals with distinct clocks when stale user commits arrive in reverse order', async () => {
      store.save(initialSettings())
      const stale = store.get()

      const late = new Promise<void>(resolve => {
        setTimeout(() => {
          commitUserEdit(store, stale, 'First requested', '2026-07-05')
          resolve()
        }, 5)
      })
      const early = Promise.resolve().then(() => {
        commitUserEdit(store, stale, 'Second requested', '2026-07-06')
      })
      await Promise.all([late, early])

      const users = store.listPendingBabyInfo({ familyId: 'family-main', limit: 10 }).items
        .filter(mutation => mutation.origin === 'user')
      expect(users.map(mutation => mutation.babyName)).toEqual(
        expect.arrayContaining(['First requested', 'Second requested']),
      )
      expect(new Set(users.map(mutation => mutation.logicalClock)).size).toBe(2)
      expect(store.getBabyInfoSummary('family-main').pendingCount).toBe(2)
    })

    it('rejects malformed and cross-family reconcile operations without writing', () => {
      store.save(initialSettings())
      const before = store.get()
      const foreign: BabyInfoMutation = {
        mutationId: '10000000-0000-4000-8000-000000000099',
        familyId: 'family-foreign',
        babyName: 'Foreign',
        babyBirthdate: '2026-01-01',
        logicalClock: 1,
        updatedAt: '2026-07-13T00:00:00.000Z',
        authorId: 'uid-foreign',
        origin: 'user',
      }
      const commit = (operation: unknown) => (
        store as SettingsStore & { commitBabyInfo: (value: unknown) => unknown }
      ).commitBabyInfo(operation)

      expect(() => commit(undefined)).toThrow(/invalid|shape/i)
      expect(() => commit({
        kind: 'reconcile',
        familyId: 'family-main',
        discoveredMutations: [foreign],
        exactAcknowledgedMutationKeys: [],
      })).toThrow(/family/i)
      expect(() => commit({
        kind: 'reconcile',
        familyId: 'family-main',
        discoveredMutations: [],
        exactAcknowledgedMutationKeys: [],
        unexpected: true,
      })).toThrow(/invalid/i)
      expect(() => commit({
        kind: 'reconcile',
        familyId: 'family-main',
        discoveredMutations: [],
        exactAcknowledgedMutationKeys: [
          'baby-info:10000000-0000-4000-8000-000000000088:10000000-0000-4000-8000-000000000077',
        ],
      })).toThrow(/known/i)
      expect(() => commit({
        kind: 'user-edit',
        familyId: 'family-main',
        babyName: 'x'.repeat(2_000_001),
        babyBirthdate: '',
      })).toThrow(/too large/i)
      expect(store.get()).toEqual(before)
    })

    it('propagates an atomic disk failure without publishing an unpersisted mutation', () => {
      store.save(initialSettings())
      store = new SettingsStore(tmpDir)
      const before = store.get()
      const settingsPath = path.join(tmpDir, 'settings.json')
      fs.rmSync(settingsPath)
      fs.mkdirSync(settingsPath)

      expect(() => commitUserEdit(
        store,
        { ...before, baby: { name: 'Must not publish', birthdate: '2026-07-07' } },
        'Must not publish',
        '2026-07-07',
      )).toThrow(/save failed/i)

      expect(store.get()).toEqual(before)
    })
  })
})
