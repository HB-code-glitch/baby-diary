import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BABY_INFO_JOURNAL_FILE, BabyInfoJournal } from '../electron/store/babyInfoJournal'
import { SettingsStore } from '../electron/store/settings'
import { getBabyInfoMutationKey } from '../shared/babyInfoResolver'
import type { AppSettings, BabyInfoMutation } from '../shared/types'
import {
  recoverSettingsAndJournalPair,
  verifyBackupSnapshot,
} from '../electron/store/backupSnapshot'
import type { DurableFileOps } from '../electron/store/durableFs'

const MANIFEST_FILE = 'manifest.json'
const RESTORE_INTENT_FILE = '.baby-info-pair-restore-v1.json'
const RESTORE_STAGING_DIR = '.baby-info-pair-restore-v1'

function mutation(index: number, familyId = 'family-A'): BabyInfoMutation {
  return {
    mutationId: `40000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    familyId,
    babyName: `Snapshot ${index}`,
    babyBirthdate: '2026-04-04',
    logicalClock: index,
    updatedAt: `2026-07-13T10:20:${String(index % 60).padStart(2, '0')}.000Z`,
    authorId: 'user-1',
    origin: 'user',
  }
}

function settingsFor(winner: BabyInfoMutation): AppSettings {
  return {
    baby: { name: winner.babyName, birthdate: winner.babyBirthdate, gender: 'girl' },
    profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
    familyId: winner.familyId,
    firebase: null,
    babyInfoJournal: {
      version: 1,
      projectedFamilyId: winner.familyId,
      projectedWinnerKey: getBabyInfoMutationKey(winner),
    },
    babyInfoRevision: winner.logicalClock,
  }
}

function digest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function writeManifest(snapshot: string, timestamp = '2026-07-13T10:20:30.000Z'): void {
  const relativePaths = ['settings.json', BABY_INFO_JOURNAL_FILE]
  const dataDir = path.join(snapshot, 'data')
  if (fs.existsSync(dataDir)) {
    relativePaths.push(...fs.readdirSync(dataDir).sort().map(name => `data/${name}`))
  }
  const files = relativePaths.map(relativePath => {
    const bytes = fs.readFileSync(path.join(snapshot, ...relativePath.split('/')))
    return { path: relativePath, size: bytes.byteLength, sha256: digest(bytes) }
  })
  fs.writeFileSync(path.join(snapshot, MANIFEST_FILE), JSON.stringify({
    version: 1,
    source: 'baby-diary',
    snapshotTimestamp: timestamp,
    files,
  }, null, 2), 'utf8')
}

function writeSnapshot(
  root: string,
  name: string,
  mutations: BabyInfoMutation[],
  acknowledgedKeys: string[] = [],
): { snapshot: string; settings: AppSettings; journal: Buffer } {
  const snapshot = path.join(root, 'backups', name)
  fs.mkdirSync(snapshot, { recursive: true })
  const familyId = mutations[0].familyId
  const journal = new BabyInfoJournal(snapshot)
  journal.ingest(familyId, mutations, acknowledgedKeys)
  const winner = mutations.reduce((left, right) => left.logicalClock > right.logicalClock ? left : right)
  const settings = settingsFor(winner)
  fs.writeFileSync(path.join(snapshot, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  fs.mkdirSync(path.join(snapshot, 'data'))
  fs.writeFileSync(path.join(snapshot, 'data', '2026-07.jsonl'), '{"event":true}\n', 'utf8')
  writeManifest(snapshot)
  return {
    snapshot,
    settings,
    journal: fs.readFileSync(path.join(snapshot, BABY_INFO_JOURNAL_FILE)),
  }
}

function writeCorruptLivePair(root: string): { settings: Buffer; journal: Buffer } {
  const settings = Buffer.from('{ broken settings', 'utf8')
  const journal = Buffer.from('{"version":1,"type":"mutation"', 'utf8')
  fs.writeFileSync(path.join(root, 'settings.json'), settings)
  fs.writeFileSync(path.join(root, BABY_INFO_JOURNAL_FILE), journal)
  return { settings, journal }
}

describe('verified settings/journal pair recovery', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-pair-recovery-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('keeps the exact validated settings buffer immutable after the source path is rewritten', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(1)])
    const settingsPath = path.join(snapshot.snapshot, 'settings.json')
    const validatedBytes = fs.readFileSync(settingsPath)
    const rewritten = JSON.parse(validatedBytes.toString('utf8')) as AppSettings
    rewritten.profile.name = 'rewritten after manifest hash'
    const rewrittenBytes = Buffer.from(JSON.stringify(rewritten, null, 2), 'utf8')
    const verified = verifyBackupSnapshot(snapshot.snapshot)
    fs.writeFileSync(settingsPath, rewrittenBytes)

    expect(verified.settingsBytes).toEqual(validatedBytes)
    expect(verified.settings.profile.name).not.toBe('rewritten after manifest hash')
  })

  it('publishes the already-verified snapshot buffers even if candidate paths change before staging', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(101)])
    const originalSettings = fs.readFileSync(path.join(snapshot.snapshot, 'settings.json'))
    const replacement = JSON.parse(originalSettings.toString('utf8')) as AppSettings
    replacement.profile.name = 'path replacement must not publish'
    writeCorruptLivePair(tmpDir)
    const realOpen = fs.openSync.bind(fs)
    let replaced = false
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
        if (!replaced
          && String(target).includes(RESTORE_STAGING_DIR)
          && String(target).includes('settings.json.tmp-')) {
          replaced = true
          fs.writeFileSync(path.join(snapshot.snapshot, 'settings.json'), JSON.stringify(replacement))
        }
        return realOpen(target, flags, mode)
      },
    }

    recoverSettingsAndJournalPair(tmpDir, { durableFs, platform: 'win32' })

    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(originalSettings)
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8')).profile.name)
      .not.toBe('path replacement must not publish')
  })

  it('rejects a snapshot directory reached through a symlink or junction', () => {
    const snapshot = writeSnapshot(tmpDir, 'real-snapshot', [mutation(108)])
    const alias = path.join(tmpDir, 'backups', 'linked-snapshot')
    fs.symlinkSync(snapshot.snapshot, alias, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => verifyBackupSnapshot(alias)).toThrow(/root|directory|symbolic/i)
  })

  it('refuses a junction forensic root and leaves both primaries untouched', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(110)])
    const original = writeCorruptLivePair(tmpDir)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-forensic-outside-'))
    try {
      fs.symlinkSync(
        outside,
        path.join(tmpDir, 'recovery-forensics'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )

      let caught: unknown
      try { recoverSettingsAndJournalPair(tmpDir) } catch (error) { caught = error }
      expect(caught).toMatchObject({
        code: 'SETTINGS_RECOVERY_REQUIRED',
        originalsPreserved: false,
      })
      expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
      expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('aborts before overwriting either primary when a forensic archive write cannot become durable', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(2)])
    const original = writeCorruptLivePair(tmpDir)
    const targets = new Map<number, string>()
    const realOpen = fs.openSync.bind(fs)
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
        const fd = realOpen(target, flags, mode)
        targets.set(fd, String(target))
        return fd
      },
      writeSync(fd, buffer, offset, length, position) {
        if (targets.get(fd)?.includes('recovery-forensics')) {
          throw new Error('injected forensic write failure')
        }
        return fs.writeSync(fd, buffer, offset, length, position)
      },
      closeSync(fd) {
        targets.delete(fd)
        fs.closeSync(fd)
      },
    }

    expect(() => (recoverSettingsAndJournalPair as unknown as (
      root: string,
      options: { durableFs: DurableFileOps },
    ) => void)(tmpDir, { durableFs })).toThrow(/forensic|preserv/i)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
  })

  it.each([
    ['settings.json', 'write'],
    ['settings.json', 'fsync'],
    ['settings.json', 'rename'],
    [BABY_INFO_JOURNAL_FILE, 'write'],
    [BABY_INFO_JOURNAL_FILE, 'fsync'],
    [BABY_INFO_JOURNAL_FILE, 'rename'],
  ] as const)(
    'keeps both primaries byte-identical when forensic %s %s fails',
    (fileName, operation) => {
      writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(102)])
      const original = writeCorruptLivePair(tmpDir)
      const targets = new Map<number, string>()
      const realOpen = fs.openSync.bind(fs)
      const inForensicFile = (target: unknown) => String(target).includes('recovery-forensics')
        && String(target).includes(fileName)
      const durableFs: DurableFileOps = {
        ...fs,
        openSync(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
          const fd = realOpen(target, flags, mode)
          targets.set(fd, String(target))
          return fd
        },
        writeSync(fd, buffer, offset, length, position) {
          if (operation === 'write' && inForensicFile(targets.get(fd))) {
            throw new Error(`injected forensic ${operation}`)
          }
          return fs.writeSync(fd, buffer, offset, length, position)
        },
        fsyncSync(fd) {
          if (operation === 'fsync' && inForensicFile(targets.get(fd))) {
            throw new Error(`injected forensic ${operation}`)
          }
          fs.fsyncSync(fd)
        },
        renameSync(oldPath, newPath) {
          if (operation === 'rename' && inForensicFile(newPath)) {
            throw new Error(`injected forensic ${operation}`)
          }
          fs.renameSync(oldPath, newPath)
        },
        closeSync(fd) {
          targets.delete(fd)
          fs.closeSync(fd)
        },
      }

      let caught: unknown
      try { recoverSettingsAndJournalPair(tmpDir, { durableFs }) } catch (error) { caught = error }
      expect(caught).toMatchObject({
        code: 'SETTINGS_RECOVERY_REQUIRED',
        originalsPreserved: false,
      })
      expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
      expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
    },
  )

  it('keeps a verified committed Windows staging copy through one later successful startup', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(3)])
    writeCorruptLivePair(tmpDir)

    ;(recoverSettingsAndJournalPair as unknown as (
      root: string,
      options: { platform: NodeJS.Platform },
    ) => void)(tmpDir, { platform: 'win32' })
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)

    ;(recoverSettingsAndJournalPair as unknown as (
      root: string,
      options: { platform: NodeJS.Platform },
    ) => void)(tmpDir, { platform: 'win32' })
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)

    ;(recoverSettingsAndJournalPair as unknown as (
      root: string,
      options: { platform: NodeJS.Platform },
    ) => void)(tmpDir, { platform: 'win32' })
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)
  })

  it('repairs a mixed primary from orphan Windows staging after the outer intent is gone', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(103)])
    writeCorruptLivePair(tmpDir)
    recoverSettingsAndJournalPair(tmpDir, { platform: 'win32' })
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)

    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{mixed primary')
    recoverSettingsAndJournalPair(tmpDir, { platform: 'win32' })

    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(
      fs.readFileSync(path.join(snapshot.snapshot, 'settings.json')),
    )
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(snapshot.journal)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)
    recoverSettingsAndJournalPair(tmpDir, { platform: 'win32' })
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)
    recoverSettingsAndJournalPair(tmpDir, { platform: 'win32' })
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)
  })

  it('commits intent removal with parent-directory fsync before POSIX staging cleanup', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(109)])
    writeCorruptLivePair(tmpDir)
    const realOpen = fs.openSync.bind(fs)
    const directoryFds = new Set<number>()
    let nextDirectoryFd = -10
    let directorySyncs = 0
    const durableFs: DurableFileOps = {
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
        if (directoryFds.has(fd)) {
          directorySyncs += 1
          return
        }
        fs.fsyncSync(fd)
      },
      closeSync(fd) {
        if (directoryFds.delete(fd)) return
        fs.closeSync(fd)
      },
    }

    recoverSettingsAndJournalPair(tmpDir, { platform: 'linux', durableFs })

    expect(directorySyncs).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)
  })

  it('fails closed when a surviving restore intent has lost its staging directory', () => {
    const original = writeCorruptLivePair(tmpDir)
    fs.writeFileSync(path.join(tmpDir, RESTORE_INTENT_FILE), JSON.stringify({
      version: 1,
      snapshotId: 'lost-stage',
      settings: { size: 1, sha256: '0'.repeat(64) },
      journal: { size: 1, sha256: '0'.repeat(64) },
    }))

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'linux' }))
      .toThrow(expect.objectContaining({ code: 'SETTINGS_RECOVERY_REQUIRED' }))
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
  })

  it('selects by verified manifest timestamp even when an older folder is renamed zzzz', () => {
    const older = writeSnapshot(tmpDir, 'zzzz', [mutation(4)])
    writeManifest(older.snapshot, '2026-07-13T10:20:30.000Z')
    const newer = writeSnapshot(tmpDir, 'aaaa', [mutation(5)])
    writeManifest(newer.snapshot, '2026-07-13T10:20:31.000Z')
    writeCorruptLivePair(tmpDir)

    const restored = new SettingsStore(tmpDir)
    expect(restored.get().baby.name).toBe(newer.settings.baby.name)
  })

  it('restores a Documents-only verified snapshot from the configured second root', () => {
    const documentsParent = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-documents-backup-'))
    try {
      const snapshot = writeSnapshot(documentsParent, '2026-07-13_10-20-30', [mutation(6)])
      writeCorruptLivePair(tmpDir)

      const restored = new (SettingsStore as unknown as new (
        root: string,
        options: { documentsBackupDir: string },
      ) => SettingsStore)(tmpDir, { documentsBackupDir: path.join(documentsParent, 'backups') })
      expect(restored.get().baby.name).toBe(snapshot.settings.baby.name)
    } finally {
      fs.rmSync(documentsParent, { recursive: true, force: true })
    }
  })

  it('resolves an exact cross-destination timestamp tie deterministically to userData', () => {
    const local = writeSnapshot(tmpDir, 'local-renamed', [mutation(104)])
    writeManifest(local.snapshot, '2026-07-13T10:20:30.000Z')
    const documentsParent = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-tie-'))
    try {
      const documents = writeSnapshot(documentsParent, 'documents-renamed', [mutation(105)])
      writeManifest(documents.snapshot, '2026-07-13T10:20:30.000Z')
      writeCorruptLivePair(tmpDir)

      const restored = new SettingsStore(tmpDir, {
        documentsBackupDir: path.join(documentsParent, 'backups'),
      })
      expect(restored.get().baby.name).toBe(local.settings.baby.name)
    } finally {
      fs.rmSync(documentsParent, { recursive: true, force: true })
    }
  })

  it('rejects a forged future manifest timestamp and chooses an older verified snapshot', () => {
    const valid = writeSnapshot(tmpDir, 'valid', [mutation(106)])
    writeManifest(valid.snapshot, '2026-07-13T10:20:30.000Z')
    const forged = writeSnapshot(tmpDir, 'forged', [mutation(107)])
    writeManifest(forged.snapshot, '2099-01-01T00:00:00.000Z')
    writeCorruptLivePair(tmpDir)

    const restored = new SettingsStore(tmpDir)
    expect(restored.get().baby.name).toBe(valid.settings.baby.name)
  })

  it('skips a newer tampered snapshot and restores the newest fully verified pair', () => {
    const pending = mutation(1)
    const acknowledged = mutation(2)
    const older = writeSnapshot(
      tmpDir,
      '2026-07-13_10-20-30',
      [pending, acknowledged],
      [getBabyInfoMutationKey(acknowledged)],
    )
    const newer = writeSnapshot(tmpDir, '2026-07-13_10-20-31', [mutation(3)])
    fs.appendFileSync(path.join(newer.snapshot, BABY_INFO_JOURNAL_FILE), 'tampered')
    writeCorruptLivePair(tmpDir)

    const restored = new SettingsStore(tmpDir)

    expect(restored.get().baby.name).toBe(older.settings.baby.name)
    expect(restored.getBabyInfoSummary('family-A')).toMatchObject({
      mutationCount: 2,
      pendingCount: 1,
      winner: acknowledged,
    })
    expect(restored.listPendingBabyInfo({ familyId: 'family-A', limit: 10 }).items)
      .toEqual([pending])
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(older.journal)
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    const forensicSnapshots = fs.readdirSync(forensicRoot)
    expect(forensicSnapshots).toHaveLength(1)
    const forensic = path.join(forensicRoot, forensicSnapshots[0])
    expect(fs.readFileSync(path.join(forensic, 'settings.json'))).toEqual(
      Buffer.from('{ broken settings', 'utf8'),
    )
    expect(JSON.parse(fs.readFileSync(path.join(forensic, 'manifest.json'), 'utf8')))
      .toMatchObject({ source: 'baby-diary-recovery' })
  })

  it.each([
    ['missing manifest', (snapshot: string) => fs.rmSync(path.join(snapshot, MANIFEST_FILE))],
    ['tampered manifest hash', (snapshot: string) => {
      const manifestPath = path.join(snapshot, MANIFEST_FILE)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      manifest.files[0].sha256 = '0'.repeat(64)
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    }],
    ['wrong projected winner', (snapshot: string) => {
      const settingsPath = path.join(snapshot, 'settings.json')
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      settings.babyInfoJournal.projectedWinnerKey = getBabyInfoMutationKey(mutation(999))
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
      writeManifest(snapshot)
    }],
    ['torn final journal record', (snapshot: string) => {
      fs.appendFileSync(path.join(snapshot, BABY_INFO_JOURNAL_FILE), '{"version":1')
      writeManifest(snapshot)
    }],
    ['corrupt middle journal record', (snapshot: string) => {
      const journalPath = path.join(snapshot, BABY_INFO_JOURNAL_FILE)
      const original = fs.readFileSync(journalPath, 'utf8')
      fs.writeFileSync(journalPath, `{bad}\n${original}`, 'utf8')
      writeManifest(snapshot)
    }],
  ])('fails closed for a journal-aware snapshot with %s', (_label, corrupt) => {
    const candidate = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(10)])
    corrupt(candidate.snapshot)
    const original = writeCorruptLivePair(tmpDir)

    let caught: unknown
    try { new SettingsStore(tmpDir) } catch (error) { caught = error }

    expect(caught).toMatchObject({ code: 'SETTINGS_RECOVERY_REQUIRED' })
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
  })

  it('accepts a manifest-less settings-only snapshot only when it truly predates journal metadata', () => {
    const legacy: AppSettings = {
      baby: { name: 'Legacy', birthdate: '2025-05-05' },
      profile: { uid: 'legacy-user', name: 'Parent', role: 'dad' },
      familyId: 'legacy-family',
      firebase: null,
    }
    const snapshot = path.join(tmpDir, 'backups', '2025-01-01_00-00-00')
    fs.mkdirSync(snapshot, { recursive: true })
    fs.writeFileSync(path.join(snapshot, 'settings.json'), JSON.stringify(legacy), 'utf8')
    writeCorruptLivePair(tmpDir)

    const restored = new SettingsStore(tmpDir)

    expect(restored.get().baby.name).toBe('Legacy')
    expect(restored.getBabyInfoSummary('legacy-family')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
    })
  })

  it.each(['before-settings', 'after-settings', 'after-journal'] as const)(
    'resumes a durable restore intent after a crash boundary: %s',
    boundary => {
      const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(20)])
      const settingsBytes = fs.readFileSync(path.join(snapshot.snapshot, 'settings.json'))
      const journalBytes = snapshot.journal
      const staging = path.join(tmpDir, RESTORE_STAGING_DIR)
      fs.mkdirSync(staging)
      fs.writeFileSync(path.join(staging, 'settings.json'), settingsBytes)
      fs.writeFileSync(path.join(staging, BABY_INFO_JOURNAL_FILE), journalBytes)
      fs.writeFileSync(path.join(tmpDir, RESTORE_INTENT_FILE), JSON.stringify({
        version: 1,
        snapshotId: '2026-07-13_10-20-30',
        settings: { size: settingsBytes.byteLength, sha256: digest(settingsBytes) },
        journal: { size: journalBytes.byteLength, sha256: digest(journalBytes) },
      }, null, 2))

      writeCorruptLivePair(tmpDir)
      if (boundary === 'after-settings' || boundary === 'after-journal') {
        fs.writeFileSync(path.join(tmpDir, 'settings.json'), settingsBytes)
      }
      if (boundary === 'after-journal') {
        fs.writeFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE), journalBytes)
      }

      const restored = new SettingsStore(tmpDir)
      expect(restored.get().baby.name).toBe(snapshot.settings.baby.name)
      expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(settingsBytes)
      expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(journalBytes)
      expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
      expect(fs.existsSync(staging)).toBe(process.platform === 'win32')
    },
  )

  it('throws a structured recoverable error and preserves both originals when no pair verifies', () => {
    const original = writeCorruptLivePair(tmpDir)

    let caught: unknown
    try { new SettingsStore(tmpDir) } catch (error) { caught = error }

    expect(caught).toMatchObject({
      code: 'SETTINGS_RECOVERY_REQUIRED',
      recoverable: true,
    })
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
  })
})
