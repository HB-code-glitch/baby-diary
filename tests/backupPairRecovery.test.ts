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
  stageVerifiedBackupSnapshot,
  verifyBackupSnapshot,
} from '../electron/store/backupSnapshot'
import type { DurableFileOps } from '../electron/store/durableFs'

const MANIFEST_FILE = 'manifest.json'
const RESTORE_INTENT_FILE = '.baby-info-pair-restore-v1.json'
const RESTORE_STAGING_DIR = '.baby-info-pair-restore-v1'

type InstrumentedDurableFileOps = DurableFileOps & {
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number
}

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

function captureThrown(action: () => unknown): Error & Record<string, unknown> {
  try {
    action()
  } catch (error) {
    if (error instanceof Error) return error as Error & Record<string, unknown>
    throw new Error(`Expected an Error instance, received ${String(error)}`)
  }
  throw new Error('Expected action to throw')
}

function copyRestoreStaging(source: string, destination: string): void {
  fs.mkdirSync(destination)
  for (const name of ['settings.json', BABY_INFO_JOURNAL_FILE, 'restore-transaction.json']) {
    fs.copyFileSync(path.join(source, name), path.join(destination, name))
  }
}

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

function forensicFootprint(root: string): { archives: number; bytes: number } {
  const forensicRoot = path.join(root, 'recovery-forensics')
  if (!fs.existsSync(forensicRoot)) return { archives: 0, bytes: 0 }
  const archiveNames = fs.readdirSync(forensicRoot)
  let bytes = 0
  for (const archiveName of archiveNames) {
    const archive = path.join(forensicRoot, archiveName)
    for (const fileName of fs.readdirSync(archive)) {
      bytes += fs.statSync(path.join(archive, fileName)).size
    }
  }
  return { archives: archiveNames.length, bytes }
}

function reachPrimaryVerifiedWindowsRestore(
  root: string,
  index: number,
  bootPrefix: string,
): {
    staleIntent: Buffer
    forensicArchive: string
  } {
  writeSnapshot(root, '2026-07-13_10-20-30', [mutation(index)])
  writeCorruptLivePair(root)
  expect(() => recoverSettingsAndJournalPair(root, {
    platform: 'win32',
    startupId: `${bootPrefix}-boot-0`,
  })).toThrow(expect.objectContaining({ restartRequired: true }))
  expect(() => recoverSettingsAndJournalPair(root, {
    platform: 'win32',
    startupId: `${bootPrefix}-boot-1`,
  })).toThrow(expect.objectContaining({ restartRequired: true }))
  expect(() => recoverSettingsAndJournalPair(root, {
    platform: 'win32',
    startupId: `${bootPrefix}-boot-2`,
  })).toThrow(expect.objectContaining({ restartRequired: true, restoreApplied: true }))

  const forensicRoot = path.join(root, 'recovery-forensics')
  return {
    staleIntent: fs.readFileSync(path.join(root, RESTORE_INTENT_FILE)),
    forensicArchive: path.join(forensicRoot, fs.readdirSync(forensicRoot)[0]),
  }
}

function cleanRestoreAndAdvanceSettings(
  root: string,
  index: number,
  bootPrefix: string,
): {
    staleIntent: Buffer
    forensicArchive: string
    liveSettings: Buffer
    liveJournal: Buffer
  } {
  const completed = reachPrimaryVerifiedWindowsRestore(root, index, bootPrefix)
  const opened = new SettingsStore(root, {
    platform: 'win32',
    startupId: `${bootPrefix}-boot-3`,
  })
  expect(fs.existsSync(path.join(root, RESTORE_INTENT_FILE))).toBe(false)
  expect(fs.existsSync(path.join(root, RESTORE_STAGING_DIR))).toBe(false)

  const advanced = opened.get()
  advanced.profile.name = 'Advanced after cleanup'
  opened.save(advanced)
  return {
    staleIntent: completed.staleIntent,
    forensicArchive: completed.forensicArchive,
    liveSettings: fs.readFileSync(path.join(root, 'settings.json')),
    liveJournal: fs.readFileSync(path.join(root, BABY_INFO_JOURNAL_FILE)),
  }
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

  it('rejects a snapshot before verification when its file-count bound is exceeded', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(114)])
    for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl']) {
      fs.writeFileSync(path.join(snapshot.snapshot, 'data', name), '{}\n')
    }
    writeManifest(snapshot.snapshot)

    expect(() => verifyBackupSnapshot(snapshot.snapshot, {
      limits: { maxSnapshotFiles: 4 },
    } as Parameters<typeof verifyBackupSnapshot>[1] & {
      limits: { maxSnapshotFiles: number }
    })).toThrow(/file.?count|too many/i)
  })

  it('rejects aggregate snapshot bytes with overflow-safe accounting', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(115)])
    const exactBytes = fs.statSync(path.join(snapshot.snapshot, 'settings.json')).size
      + fs.statSync(path.join(snapshot.snapshot, BABY_INFO_JOURNAL_FILE)).size
      + fs.statSync(path.join(snapshot.snapshot, 'data', '2026-07.jsonl')).size

    expect(() => verifyBackupSnapshot(snapshot.snapshot, {
      limits: { maxTotalSnapshotBytes: exactBytes - 1 },
    } as Parameters<typeof verifyBackupSnapshot>[1] & {
      limits: { maxTotalSnapshotBytes: number }
    })).toThrow(/aggregate|total snapshot bytes/i)
  })

  it('streams event data without retaining a whole event-file Buffer', () => {
    const source = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(116)])
    fs.writeFileSync(path.join(source.snapshot, 'data', '2026-07.jsonl'), Buffer.alloc(256 * 1024, 0x61))
    writeManifest(source.snapshot)
    fs.copyFileSync(path.join(source.snapshot, 'settings.json'), path.join(tmpDir, 'settings.json'))
    fs.copyFileSync(path.join(source.snapshot, BABY_INFO_JOURNAL_FILE), path.join(tmpDir, BABY_INFO_JOURNAL_FILE))
    fs.mkdirSync(path.join(tmpDir, 'data'))
    fs.copyFileSync(
      path.join(source.snapshot, 'data', '2026-07.jsonl'),
      path.join(tmpDir, 'data', '2026-07.jsonl'),
    )
    const staging = path.join(tmpDir, 'stream-stage')
    fs.mkdirSync(staging)
    const realAlloc = Buffer.alloc.bind(Buffer)
    let largestAllocation = 0
    const allocSpy = vi.spyOn(Buffer, 'alloc').mockImplementation((size: number, fill?: unknown, encoding?: unknown) => {
      largestAllocation = Math.max(largestAllocation, size)
      return realAlloc(size, fill as never, encoding as never)
    })

    try {
      stageVerifiedBackupSnapshot(
        tmpDir,
        staging,
        '2026-07-13T10:20:30.000Z',
        'win32',
      )
    } finally {
      allocSpy.mockRestore()
    }

    expect(largestAllocation).toBeLessThanOrEqual(64 * 1024)
    expect(fs.readFileSync(path.join(staging, 'data', '2026-07.jsonl'))).toEqual(
      fs.readFileSync(path.join(tmpDir, 'data', '2026-07.jsonl')),
    )
  })

  it('fails closed when backup candidate discovery exceeds its configured bound', () => {
    for (let index = 0; index < 3; index += 1) {
      writeSnapshot(tmpDir, `candidate-${index}`, [mutation(120 + index)])
    }
    const original = writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'candidate-bound-boot',
      limits: { maxCandidates: 2 },
    } as Parameters<typeof recoverSettingsAndJournalPair>[1] & {
      limits: { maxCandidates: number }
    })).toThrow(/candidate.?count|too many backup candidates/i)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
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

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      durableFs,
      platform: 'win32',
      startupId: 'buffer-boot-0',
    })).toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      durableFs,
      platform: 'win32',
      startupId: 'buffer-boot-1',
    })).toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      durableFs,
      platform: 'win32',
      startupId: 'buffer-boot-2',
    })).toThrow(expect.objectContaining({
      restartRequired: true,
      restoreApplied: true,
      primaryUntouched: false,
    }))

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

  it('rejects an archive-directory junction swap before writing outside the forensic root', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(121)])
    const original = writeCorruptLivePair(tmpDir)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-forensic-race-'))
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    let swapped = false
    const durableFs: DurableFileOps = {
      ...fs,
      mkdirSync(target, options) {
        const result = fs.mkdirSync(target, options)
        const resolved = path.resolve(String(target))
        if (!swapped && path.dirname(resolved) === path.resolve(forensicRoot)) {
          swapped = true
          fs.rmSync(resolved, { recursive: true, force: true })
          fs.symlinkSync(outside, resolved, process.platform === 'win32' ? 'junction' : 'dir')
        }
        return result
      },
    }

    try {
      let caught: unknown
      try {
        recoverSettingsAndJournalPair(tmpDir, {
          platform: 'win32',
          durableFs,
          startupId: 'archive-race-boot-0',
        })
      } catch (error) { caught = error }

      expect(caught).toMatchObject({
        code: 'SETTINGS_RECOVERY_REQUIRED',
        originalsPreserved: false,
      })
      expect(swapped).toBe(true)
      expect(fs.readdirSync(outside)).toEqual([])
      expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
      expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
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

  it('bounds deterministic forensic archive allocation when every suffix is occupied', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(120)])
    const original = writeCorruptLivePair(tmpDir)
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    fs.mkdirSync(forensicRoot)
    let allocationChecks = 0
    const durableFs: DurableFileOps = {
      ...fs,
      mkdirSync(target, options) {
        const resolved = path.resolve(String(target))
        if (path.dirname(resolved) === path.resolve(forensicRoot)) {
          allocationChecks += 1
          if (allocationChecks > 64) throw new Error('unbounded forensic allocation probe')
          throw Object.assign(new Error('occupied forensic archive'), { code: 'EEXIST' })
        }
        return fs.mkdirSync(target, options)
      },
    }

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      durableFs,
      startupId: 'allocation-boot-0',
    })).toThrow(/forensic archive allocation attempts exhausted/i)
    expect(allocationChecks).toBe(64)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
  })

  it('reuses exact forensic evidence across repeated no-backup startups', () => {
    const original = writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'no-backup-0',
      now: new Date('2026-07-14T00:00:00.000Z'),
    })).toThrow(expect.objectContaining({ primaryUntouched: true }))
    const first = forensicFootprint(tmpDir)
    expect(first.archives).toBe(1)

    for (const [startupId, now] of [
      ['no-backup-1', '2026-07-14T01:00:00.000Z'],
      ['no-backup-2', '2026-07-14T02:00:00.000Z'],
    ] as const) {
      expect(() => recoverSettingsAndJournalPair(tmpDir, {
        platform: 'win32',
        startupId,
        now: new Date(now),
      })).toThrow(expect.objectContaining({
        originalsPreserved: true,
        primaryUntouched: true,
      }))
      expect(forensicFootprint(tmpDir)).toEqual(first)
      expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
      expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
    }
  })

  it('does not reuse a same-digest forensic archive whose exact evidence changed', () => {
    writeCorruptLivePair(tmpDir)
    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'invalid-reuse-0',
      now: new Date('2026-07-14T00:00:00.000Z'),
    })).toThrow()
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    const firstArchive = fs.readdirSync(forensicRoot)[0]
    fs.appendFileSync(path.join(forensicRoot, firstArchive, 'settings.json'), 'tampered')

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'invalid-reuse-1',
      now: new Date('2026-07-14T01:00:00.000Z'),
    })).toThrow(expect.objectContaining({ primaryUntouched: true }))
    expect(fs.readdirSync(forensicRoot)).toHaveLength(2)
  })

  it('fails closed when the forensic archive root has reached its bounded capacity', () => {
    const original = writeCorruptLivePair(tmpDir)
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    fs.mkdirSync(forensicRoot)
    for (let index = 0; index < 64; index += 1) {
      fs.mkdirSync(path.join(forensicRoot, `unrelated-${index}`))
    }

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'forensic-capacity',
    })).toThrow(/forensic archive capacity/i)
    expect(fs.readdirSync(forensicRoot)).toHaveLength(64)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
  })

  it('bounds forensic root enumeration before considering an over-capacity root', () => {
    writeCorruptLivePair(tmpDir)
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    fs.mkdirSync(forensicRoot)
    for (let index = 0; index < 65; index += 1) {
      fs.mkdirSync(path.join(forensicRoot, `hostile-${index}`))
    }

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'forensic-overflow',
    })).toThrow(/forensic archive entry count exceeds its configured bound/i)
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

  it('requires a final independent Windows startup after publishing the restored primaries', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(3)])
    const original = writeCorruptLivePair(tmpDir)
    const primaryWrites: string[] = []
    const realRename = fs.renameSync.bind(fs)
    const durableFs: DurableFileOps = {
      ...fs,
      renameSync(oldPath, newPath) {
        if ([path.join(tmpDir, 'settings.json'), path.join(tmpDir, BABY_INFO_JOURNAL_FILE)]
          .includes(String(newPath))) {
          primaryWrites.push(String(newPath))
        }
        realRename(oldPath, newPath)
      },
    }

    let first: unknown
    try {
      recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', durableFs, startupId: 'boot-0' })
    } catch (error) { first = error }
    expect(first).toMatchObject({
      code: 'SETTINGS_RECOVERY_REQUIRED',
      restartRequired: true,
      originalsPreserved: false,
    })
    expect(primaryWrites).toEqual([])
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)

    let second: unknown
    try {
      recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', durableFs, startupId: 'boot-1' })
    } catch (error) { second = error }
    expect(second).toMatchObject({ restartRequired: true, originalsPreserved: false })
    expect(primaryWrites).toEqual([])
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)

    let third: unknown
    try {
      recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', durableFs, startupId: 'boot-2' })
    } catch (error) { third = error }
    expect(third).toMatchObject({
      restartRequired: true,
      restoreApplied: true,
      localDataModified: true,
      originalsPreserved: true,
      primaryUntouched: false,
    })
    expect(primaryWrites).toHaveLength(2)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(
      fs.readFileSync(path.join(snapshot.snapshot, 'settings.json')),
    )
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(true)
    recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', durableFs, startupId: 'boot-3' })
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
  })

  it('blocks SettingsStore on restore publication, then preserves later valid advancement', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(126)])
    writeCorruptLivePair(tmpDir)

    expect(() => new SettingsStore(tmpDir, { platform: 'win32', startupId: 'gate-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true, primaryUntouched: true }))
    expect(() => new SettingsStore(tmpDir, { platform: 'win32', startupId: 'gate-boot-1' }))
      .toThrow(expect.objectContaining({ restartRequired: true, primaryUntouched: true }))
    expect(() => new SettingsStore(tmpDir, { platform: 'win32', startupId: 'gate-boot-2' }))
      .toThrow(expect.objectContaining({
        restartRequired: true,
        restoreApplied: true,
        primaryUntouched: false,
      }))

    const opened = new SettingsStore(tmpDir, { platform: 'win32', startupId: 'gate-boot-3' })
    const changed = opened.get()
    changed.profile.name = 'Changed after successful restore'
    opened.save(changed)

    const nextBoot = new SettingsStore(tmpDir, { platform: 'win32', startupId: 'gate-boot-4' })
    expect(nextBoot.get().profile.name).toBe('Changed after successful restore')
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
  })

  it('fails closed on a later Windows startup when forensic evidence changed', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(111)])
    const original = writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true, originalsPreserved: false }))
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    const archive = fs.readdirSync(forensicRoot)[0]
    fs.appendFileSync(path.join(forensicRoot, archive, 'settings.json'), 'tampered')

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'boot-1' }))
      .toThrow(expect.objectContaining({ restartRequired: true, originalsPreserved: false }))
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
  })

  it('rejects divergent Windows transaction controls before a forged completed phase can overwrite primaries', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(122)])
    const original = writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'control-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    const metadataPath = path.join(tmpDir, RESTORE_STAGING_DIR, 'restore-transaction.json')
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    metadata.phase = 'primary-verified'
    metadata.windowsVerifiedStartups = 2
    metadata.lastWindowsStartupId = 'forged-control'
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'control-boot-1' }))
      .toThrow(/transaction controls|metadata differ|shape is invalid/i)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
  })

  it('accepts only an exact one-publication-ahead Windows verification transition', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(123)])
    const original = writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'ahead-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    const metadataPath = path.join(tmpDir, RESTORE_STAGING_DIR, 'restore-transaction.json')
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    metadata.windowsVerifiedStartups = 1
    metadata.lastWindowsStartupId = 'ahead-crashed-boot'
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'ahead-crashed-boot',
    })).toThrow(expect.objectContaining({ restartRequired: true }))
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'ahead-boot-2',
    })).toThrow(expect.objectContaining({ restartRequired: true, restoreApplied: true }))
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(
      fs.readFileSync(path.join(snapshot.snapshot, 'settings.json')),
    )
  })

  it('will not adopt primary-verified staging unless the live pair and forensic evidence both verify', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(124)])
    writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'primary-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'primary-boot-1' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'primary-boot-2',
    })).toThrow(expect.objectContaining({ restartRequired: true, restoreApplied: true }))

    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const forensicArchive = path.join(
      tmpDir,
      'recovery-forensics',
      fs.readdirSync(path.join(tmpDir, 'recovery-forensics'))[0],
    )
    fs.appendFileSync(path.join(forensicArchive, 'settings.json'), 'tampered')
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'primary-boot-3' }))
      .toThrow(/forensic|checksum/i)
    expect(fs.existsSync(intentPath)).toBe(true)
  })

  it('finalizes a primary-verified Windows intent when staging vanished but exact live and forensic evidence survive', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(130)])
    writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'vanished-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'vanished-boot-1' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'vanished-boot-2' }))
      .toThrow(expect.objectContaining({ restartRequired: true, restoreApplied: true }))

    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))
    const liveJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))
    fs.rmSync(stagingPath, { recursive: true, force: true })

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'vanished-boot-3',
    })).not.toThrow()
    expect(fs.existsSync(intentPath)).toBe(false)
    expect(fs.existsSync(stagingPath)).toBe(false)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(liveJournal)
    expect(liveSettings).toEqual(fs.readFileSync(path.join(snapshot.snapshot, 'settings.json')))
    expect(liveJournal).toEqual(snapshot.journal)
  })

  it('cleans a reappeared exact stale intent after SettingsStore validly advances the restored live pair', () => {
    const advanced = cleanRestoreAndAdvanceSettings(tmpDir, 134, 'stale-advanced')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    fs.writeFileSync(intentPath, advanced.staleIntent)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)

    const boot4 = new SettingsStore(tmpDir, {
      platform: 'win32',
      startupId: 'stale-advanced-boot-4',
    })

    expect(boot4.get().profile.name).toBe('Advanced after cleanup')
    expect(fs.existsSync(intentPath)).toBe(false)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(advanced.liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(advanced.liveJournal)
  })

  it('cleans a reappeared stale intent and staging pair after a valid live advancement', () => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 144, 'stale-both')
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-stale-stage-'))
    const stageCopy = path.join(holder, 'stage')
    try {
      copyRestoreStaging(path.join(tmpDir, RESTORE_STAGING_DIR), stageCopy)
      const opened = new SettingsStore(tmpDir, {
        platform: 'win32',
        startupId: 'stale-both-boot-3',
      })
      const changed = opened.get()
      changed.profile.name = 'Valid advancement with both stale artifacts'
      opened.save(changed)
      const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))
      const liveJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))

      fs.writeFileSync(path.join(tmpDir, RESTORE_INTENT_FILE), completed.staleIntent)
      copyRestoreStaging(stageCopy, path.join(tmpDir, RESTORE_STAGING_DIR))

      const nextBoot = new SettingsStore(tmpDir, {
        platform: 'win32',
        startupId: 'stale-both-boot-4',
      })
      expect(nextBoot.get().profile.name).toBe('Valid advancement with both stale artifacts')
      expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
      expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)
      expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
      expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(liveJournal)
    } finally {
      fs.rmSync(holder, { recursive: true, force: true })
    }
  })

  it('accepts a real journal append with its matching settings projection as restored lineage', () => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 145, 'lineage-append')
    const opened = new SettingsStore(tmpDir, {
      platform: 'win32',
      startupId: 'lineage-append-boot-3',
    })
    const restoredJournalSize = fs.statSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE)).size
    opened.commitBabyInfo({
      kind: 'user-edit',
      familyId: 'family-A',
      babyName: 'Valid lineage descendant',
      babyBirthdate: '2026-05-05',
    })
    const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))
    const liveJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))
    expect(liveJournal.byteLength).toBeGreaterThan(restoredJournalSize)

    fs.writeFileSync(path.join(tmpDir, RESTORE_INTENT_FILE), completed.staleIntent)
    const nextBoot = new SettingsStore(tmpDir, {
      platform: 'win32',
      startupId: 'lineage-append-boot-4',
    })

    expect(nextBoot.get().baby).toMatchObject({
      name: 'Valid lineage descendant',
      birthdate: '2026-05-05',
    })
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(liveJournal)
  })

  it('rejects a live journal shorter than the restored lineage without overwriting it', () => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 146, 'lineage-short')
    new SettingsStore(tmpDir, { platform: 'win32', startupId: 'lineage-short-boot-3' })
    const intent = JSON.parse(completed.staleIntent.toString('utf8'))
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const shorter = fs.readFileSync(journalPath).subarray(0, intent.journal.size - 1)
    fs.writeFileSync(journalPath, shorter)
    fs.writeFileSync(path.join(tmpDir, RESTORE_INTENT_FILE), completed.staleIntent)
    const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))

    const error = captureThrown(() => new SettingsStore(tmpDir, {
      platform: 'win32',
      startupId: 'lineage-short-boot-4',
    }))
    expect(error.message).toMatch(/lineage/i)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
    expect(fs.readFileSync(journalPath)).toEqual(shorter)
  })

  it.each([
    ['same-size', [mutation(202, 'family-B')]],
    ['longer', [mutation(202, 'family-B'), mutation(203, 'family-B')]],
  ])('rejects a valid %s journal whose prefix diverges from the restored lineage', (label, mutations) => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 201, `lineage-${label}`)
    new SettingsStore(tmpDir, {
      platform: 'win32',
      startupId: `lineage-${label}-boot-3`,
    })
    const intent = JSON.parse(completed.staleIntent.toString('utf8'))
    const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-lineage-unrelated-'))
    try {
      const unrelated = writeSnapshot(unrelatedRoot, '2026-07-13_10-20-30', mutations)
      if (label === 'same-size') expect(unrelated.journal.byteLength).toBe(intent.journal.size)
      else expect(unrelated.journal.byteLength).toBeGreaterThan(intent.journal.size)
      fs.copyFileSync(path.join(unrelated.snapshot, 'settings.json'), path.join(tmpDir, 'settings.json'))
      fs.copyFileSync(
        path.join(unrelated.snapshot, BABY_INFO_JOURNAL_FILE),
        path.join(tmpDir, BABY_INFO_JOURNAL_FILE),
      )
      fs.writeFileSync(path.join(tmpDir, RESTORE_INTENT_FILE), completed.staleIntent)
      const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))
      const liveJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))

      const error = captureThrown(() => new SettingsStore(tmpDir, {
        platform: 'win32',
        startupId: `lineage-${label}-boot-4`,
      }))
      expect(error.message).toMatch(/lineage/i)
      expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(true)
      expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
      expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(liveJournal)
    } finally {
      fs.rmSync(unrelatedRoot, { recursive: true, force: true })
    }
  })

  it('accepts a bounded torn final suffix under normal journal replay policy', () => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 147, 'lineage-torn')
    new SettingsStore(tmpDir, { platform: 'win32', startupId: 'lineage-torn-boot-3' })
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    fs.appendFileSync(journalPath, '{"version":1')
    fs.writeFileSync(path.join(tmpDir, RESTORE_INTENT_FILE), completed.staleIntent)
    const tornJournal = fs.readFileSync(journalPath)
    const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))

    const nextBoot = new SettingsStore(tmpDir, {
      platform: 'win32',
      startupId: 'lineage-torn-boot-4',
    })
    expect(nextBoot.get().baby.name).toBe('Snapshot 147')
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
    expect(fs.readFileSync(journalPath)).toEqual(tornJournal)
  })

  it('streams a valid 128 MiB advancement end-to-end, bounds invalid reads, and rejects one byte over', () => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 148, 'lineage-boundary')
    new SettingsStore(tmpDir, { platform: 'win32', startupId: 'lineage-boundary-boot-3' })
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const maximumJournalBytes = 128 * 1024 * 1024
    const restoredPrefix = fs.readFileSync(journalPath)
    expect(restoredPrefix.at(-1)).toBe(0x0a)
    const importJson = Buffer.from('{"version":1,"type":"import","sourceId":"boundary-fill"}', 'utf8')
    const makeImportLine = (size: number): Buffer => {
      if (size < importJson.byteLength + 1 || size > 64 * 1024) {
        throw new Error(`invalid synthetic import line size: ${size}`)
      }
      return Buffer.concat([
        importJson,
        Buffer.alloc(size - importJson.byteLength - 1, 0x20),
        Buffer.from('\n'),
      ], size)
    }
    const fullLine = makeImportLine(64 * 1024)
    const tailBytes = maximumJournalBytes - restoredPrefix.byteLength
    const fullLineCount = Math.floor(tailBytes / fullLine.byteLength)
    const finalLineSize = tailBytes - (fullLineCount * fullLine.byteLength)
    expect(finalLineSize).toBeGreaterThanOrEqual(importJson.byteLength + 1)
    const finalLine = makeImportLine(finalLineSize)
    const fullLineRegionBytes = fullLineCount * fullLine.byteLength

    fs.writeFileSync(intentPath, completed.staleIntent)
    fs.truncateSync(journalPath, maximumJournalBytes)
    const readRequests: Array<{ position: number; length: number }> = []
    const streamingFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        if (position === null) throw new Error('live advancement reads must be positional')
        readRequests.push({ position, length })
        const target = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        let sourcePosition = position
        let targetOffset = offset
        let remaining = length
        while (remaining > 0) {
          if (sourcePosition < restoredPrefix.byteLength) {
            const count = Math.min(remaining, restoredPrefix.byteLength - sourcePosition)
            restoredPrefix.copy(target, targetOffset, sourcePosition, sourcePosition + count)
            sourcePosition += count
            targetOffset += count
            remaining -= count
            continue
          }

          const tailPosition = sourcePosition - restoredPrefix.byteLength
          if (tailPosition < fullLineRegionBytes) {
            const lineOffset = tailPosition % fullLine.byteLength
            const count = Math.min(remaining, fullLine.byteLength - lineOffset)
            fullLine.copy(target, targetOffset, lineOffset, lineOffset + count)
            sourcePosition += count
            targetOffset += count
            remaining -= count
            continue
          }

          const finalOffset = tailPosition - fullLineRegionBytes
          const count = Math.min(remaining, finalLine.byteLength - finalOffset)
          finalLine.copy(target, targetOffset, finalOffset, finalOffset + count)
          sourcePosition += count
          targetOffset += count
          remaining -= count
        }
        return length
      },
    }

    const rssBefore = process.memoryUsage().rss
    const startedAt = Date.now()
    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'lineage-boundary-boot-4',
      durableFs: streamingFs,
    })).not.toThrow()
    const elapsedMs = Date.now() - startedAt
    const rssGrowth = Math.max(0, process.memoryUsage().rss - rssBefore)
    expect(readRequests.length).toBeGreaterThan(0)
    expect(Math.max(...readRequests.map(request => request.length))).toBeLessThanOrEqual(64 * 1024)
    expect(readRequests.reduce((total, request) => total + request.length, 0)).toBe(maximumJournalBytes)
    expect(readRequests.at(-1)!.position + readRequests.at(-1)!.length).toBe(maximumJournalBytes)
    expect(elapsedMs).toBeLessThan(10_000)
    expect(rssGrowth).toBeLessThan(96 * 1024 * 1024)
    expect(fs.existsSync(intentPath)).toBe(false)

    fs.writeFileSync(intentPath, completed.staleIntent)
    const invalidReadRequests: Array<{ position: number; length: number }> = []
    const actualStreamingFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        if (position === null) throw new Error('live advancement reads must be positional')
        invalidReadRequests.push({ position, length })
        return fs.readSync(fd, buffer, offset, length, position)
      },
    }
    const atBoundary = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'lineage-boundary-invalid-boot-4',
      durableFs: actualStreamingFs,
    }))
    expect(atBoundary.message).toMatch(/journal record exceeds its size bound/i)
    expect(atBoundary.message).not.toMatch(/backup file exceeds its size bound/i)
    expect(Math.max(...invalidReadRequests.map(request => request.length))).toBeLessThanOrEqual(64 * 1024)
    expect(invalidReadRequests.reduce((total, request) => total + request.length, 0))
      .toBeLessThanOrEqual(128 * 1024)
    const invalidReadsAtBoundary = invalidReadRequests.length

    fs.truncateSync(journalPath, maximumJournalBytes + 1)
    const overBoundary = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'lineage-boundary-boot-5',
      durableFs: actualStreamingFs,
    }))
    expect(overBoundary.message).toMatch(/exceeds its size bound/i)
    expect(invalidReadRequests).toHaveLength(invalidReadsAtBoundary)
    expect(fs.existsSync(intentPath)).toBe(true)
  })

  it.each([
    ['missing settings', 135, (root: string) => fs.unlinkSync(path.join(root, 'settings.json'))],
    ['missing journal', 136, (root: string) => fs.unlinkSync(path.join(root, BABY_INFO_JOURNAL_FILE))],
    ['corrupt settings', 137, (root: string) => fs.writeFileSync(path.join(root, 'settings.json'), '{broken live')],
    ['corrupt journal', 138, (root: string) => fs.writeFileSync(path.join(root, BABY_INFO_JOURNAL_FILE), '{"version":1')],
  ])('keeps a reappeared stale intent and fails closed on %s after valid advancement', (label, index, damageLive) => {
    const advanced = cleanRestoreAndAdvanceSettings(
      tmpDir,
      index,
      label.replace(' ', '-'),
    )
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    fs.writeFileSync(intentPath, advanced.staleIntent)
    damageLive(tmpDir)
    const settingsPath = path.join(tmpDir, 'settings.json')
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const beforeSettings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null
    const beforeJournal = fs.existsSync(journalPath) ? fs.readFileSync(journalPath) : null

    expect(() => new SettingsStore(tmpDir, {
      platform: 'win32',
      startupId: `${label.replace(' ', '-')}-boot-4`,
    })).toThrow(/live|settings|journal|checksum|corrupt|valid advancement/i)
    expect(fs.existsSync(intentPath)).toBe(true)
    expect(fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null).toEqual(beforeSettings)
    expect(fs.existsSync(journalPath) ? fs.readFileSync(journalPath) : null).toEqual(beforeJournal)
  })

  it('fails closed on changed forensic evidence when an exact stale intent reappears after valid advancement', () => {
    const advanced = cleanRestoreAndAdvanceSettings(tmpDir, 139, 'stale-forensic')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    fs.writeFileSync(intentPath, advanced.staleIntent)
    fs.appendFileSync(path.join(advanced.forensicArchive, 'settings.json'), 'tampered')

    expect(() => new SettingsStore(tmpDir, {
      platform: 'win32',
      startupId: 'stale-forensic-boot-4',
    })).toThrow(/forensic|checksum/i)
    expect(fs.existsSync(intentPath)).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(advanced.liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(advanced.liveJournal)
  })

  it('fails closed when a reappeared stale intent no longer has its exact transaction identity', () => {
    const advanced = cleanRestoreAndAdvanceSettings(tmpDir, 140, 'stale-identity')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const forged = JSON.parse(advanced.staleIntent.toString('utf8'))
    forged.snapshotId = 'forged-snapshot-identity'
    fs.writeFileSync(intentPath, JSON.stringify(forged, null, 2))

    const error = captureThrown(() => new SettingsStore(tmpDir, {
      platform: 'win32',
      startupId: 'stale-identity-boot-4',
    }))
    expect(error.message).toMatch(/transaction identity|verified backup|snapshot/i)
    expect(error).toMatchObject({
      restartRequired: false,
      primaryUntouched: false,
      restoreApplied: true,
      recoveryFollowUpRequired: true,
      localDataModified: true,
      originalsPreserved: false,
    })
    expect(fs.existsSync(intentPath)).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(advanced.liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(advanced.liveJournal)
  })

  it('rejects an unrelated readable pair rather than treating it as an advancement of a stale intent', () => {
    const advanced = cleanRestoreAndAdvanceSettings(tmpDir, 141, 'stale-unrelated')
    const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-unrelated-live-'))
    try {
      const unrelated = writeSnapshot(unrelatedRoot, '2026-07-13_10-20-30', [mutation(142, 'family-B')])
      fs.copyFileSync(path.join(unrelated.snapshot, 'settings.json'), path.join(tmpDir, 'settings.json'))
      fs.copyFileSync(
        path.join(unrelated.snapshot, BABY_INFO_JOURNAL_FILE),
        path.join(tmpDir, BABY_INFO_JOURNAL_FILE),
      )
      const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
      fs.writeFileSync(intentPath, advanced.staleIntent)
      const unrelatedSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))
      const unrelatedJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))

      expect(() => new SettingsStore(tmpDir, {
        platform: 'win32',
        startupId: 'stale-unrelated-boot-4',
      })).toThrow(/advance|lineage|transaction|settings\/journal/i)
      expect(fs.existsSync(intentPath)).toBe(true)
      expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(unrelatedSettings)
      expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(unrelatedJournal)
    } finally {
      fs.rmSync(unrelatedRoot, { recursive: true, force: true })
    }
  })

  it.each([
    ['mismatched', (root: string) => fs.writeFileSync(path.join(root, 'settings.json'), '{mixed live')],
    ['missing', (root: string) => fs.unlinkSync(path.join(root, 'settings.json'))],
  ])('fails closed when staging vanished and the primary-verified live pair is %s', (_case, damageLive) => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(_case === 'mismatched' ? 131 : 132)])
    writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: `${_case}-boot-0` }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: `${_case}-boot-1` }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: `${_case}-boot-2` }))
      .toThrow(expect.objectContaining({ restartRequired: true, restoreApplied: true }))

    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    fs.rmSync(path.join(tmpDir, RESTORE_STAGING_DIR), { recursive: true, force: true })
    damageLive(tmpDir)
    const settingsPath = path.join(tmpDir, 'settings.json')
    const liveSettings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null
    const liveJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: `${_case}-boot-3`,
    }))
    expect(error.message).toMatch(/live settings\/journal pair|does not match|settings\/journal|lineage/i)
    expect(error).toMatchObject({
      restartRequired: false,
      primaryUntouched: false,
      restoreApplied: true,
      recoveryFollowUpRequired: true,
      localDataModified: true,
      originalsPreserved: true,
    })
    expect(fs.existsSync(intentPath)).toBe(true)
    expect(fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null).toEqual(liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(liveJournal)
  })

  it('fails closed when staging vanished and primary-verified forensic evidence no longer matches', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(133)])
    writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'forensic-gone-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'forensic-gone-boot-1' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'forensic-gone-boot-2' }))
      .toThrow(expect.objectContaining({ restartRequired: true, restoreApplied: true }))

    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    fs.rmSync(path.join(tmpDir, RESTORE_STAGING_DIR), { recursive: true, force: true })
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    const forensicArchive = path.join(forensicRoot, fs.readdirSync(forensicRoot)[0])
    fs.appendFileSync(path.join(forensicArchive, 'settings.json'), 'tampered')
    const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))
    const liveJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'forensic-gone-boot-3',
    }))
    expect(error.message).toMatch(/forensic|checksum/i)
    expect(error).toMatchObject({
      restartRequired: false,
      primaryUntouched: false,
      restoreApplied: true,
      recoveryFollowUpRequired: true,
      localDataModified: true,
      originalsPreserved: false,
    })
    expect(fs.existsSync(intentPath)).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(liveJournal)
  })

  it('bounds forensic archive enumeration before rejecting hostile extra entries', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(119)])
    const original = writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'bounded-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true, originalsPreserved: false }))
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    const archive = path.join(forensicRoot, fs.readdirSync(forensicRoot)[0])
    for (let index = 0; index < 8; index += 1) {
      fs.writeFileSync(path.join(archive, `hostile-${index}.bin`), 'noise')
    }

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'bounded-boot-1' }))
      .toThrow(/forensic archive entry count exceeds its configured bound/i)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)
  })

  it('publishes an allocation marker before either staged pair member', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(112)])
    writeCorruptLivePair(tmpDir)
    const published: string[] = []
    const realRename = fs.renameSync.bind(fs)
    const durableFs: DurableFileOps = {
      ...fs,
      renameSync(oldPath, newPath) {
        const destination = String(newPath)
        if (destination.includes(RESTORE_STAGING_DIR) || destination.endsWith(RESTORE_INTENT_FILE)) {
          published.push(path.relative(tmpDir, destination))
        }
        realRename(oldPath, newPath)
      },
    }

    try { recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', durableFs, startupId: 'boot-0' }) } catch {
      // Wave 4 Windows preparation deliberately pauses before primary overwrite.
    }

    expect(published.slice(0, 5)).toEqual([
      path.join(RESTORE_STAGING_DIR, 'restore-transaction.json'),
      path.join(RESTORE_STAGING_DIR, 'settings.json'),
      path.join(RESTORE_STAGING_DIR, BABY_INFO_JOURNAL_FILE),
      path.join(RESTORE_STAGING_DIR, 'restore-transaction.json'),
      RESTORE_INTENT_FILE,
    ])
  })

  it('garbage-collects metadata-free no-intent staging and continues from a readable live pair', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(113)])
    fs.copyFileSync(path.join(snapshot.snapshot, 'settings.json'), path.join(tmpDir, 'settings.json'))
    fs.copyFileSync(path.join(snapshot.snapshot, BABY_INFO_JOURNAL_FILE), path.join(tmpDir, BABY_INFO_JOURNAL_FILE))
    const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))
    const liveJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))
    const staging = path.join(tmpDir, RESTORE_STAGING_DIR)
    fs.mkdirSync(staging)
    fs.writeFileSync(path.join(staging, 'settings.json'), '{partial stage')

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32' })).not.toThrow()
    expect(fs.existsSync(staging)).toBe(false)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(liveJournal)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32' })).not.toThrow()
  })

  it('preserves a valid advanced live pair when completed Windows staging is orphaned', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(103)])
    writeCorruptLivePair(tmpDir)
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'mixed-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'mixed-boot-1' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'mixed-boot-2',
    })).toThrow(expect.objectContaining({ restartRequired: true, restoreApplied: true }))
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)

    fs.unlinkSync(path.join(tmpDir, RESTORE_INTENT_FILE))
    const advanced = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8')) as AppSettings
    advanced.profile.name = 'valid advancement after an old restore'
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(advanced, null, 2))
    recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'mixed-boot-3' })

    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8')).profile.name)
      .toBe('valid advancement after an old restore')
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(snapshot.journal)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)
  })

  it('keeps orphan completed staging when valid advancement has mismatched forensic evidence', () => {
    const advanced = cleanRestoreAndAdvanceSettings(tmpDir, 143, 'orphan-forensic-advance')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    fs.mkdirSync(stagingPath)
    fs.writeFileSync(path.join(stagingPath, 'restore-transaction.json'), advanced.staleIntent)
    fs.appendFileSync(path.join(advanced.forensicArchive, 'settings.json'), 'tampered')
    const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))
    const liveJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'orphan-forensic-advance-boot-3',
    })).toThrow(/forensic|checksum/i)
    expect(fs.existsSync(stagingPath)).toBe(true)
    expect(fs.existsSync(intentPath)).toBe(false)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(liveJournal)
  })

  it('does not overwrite an unreadable live mismatch from orphan primary-verified staging', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(127)])
    writeCorruptLivePair(tmpDir)
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'bad-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'bad-boot-1' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'bad-boot-2' }))
      .toThrow(expect.objectContaining({ restoreApplied: true }))
    fs.unlinkSync(path.join(tmpDir, RESTORE_INTENT_FILE))
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{mixed primary')
    const beforeJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'bad-boot-3',
    })).toThrow(/orphan|live settings\/journal pair/i)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8')).toBe('{mixed primary')
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(beforeJournal)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)
  })

  it('does not discard orphan completed staging when both live primaries are missing', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(128)])
    writeCorruptLivePair(tmpDir)
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'missing-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'missing-boot-1' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'missing-boot-2' }))
      .toThrow(expect.objectContaining({ restoreApplied: true }))
    fs.unlinkSync(path.join(tmpDir, RESTORE_INTENT_FILE))
    fs.unlinkSync(path.join(tmpDir, 'settings.json'))
    fs.unlinkSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'missing-boot-3',
    })).toThrow(/orphan|live settings\/journal pair/i)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)
  })

  it('cleans partial completed staging when the exact restored live pair survives', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(129)])
    writeCorruptLivePair(tmpDir)
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'partial-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'partial-boot-1' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'partial-boot-2' }))
      .toThrow(expect.objectContaining({ restoreApplied: true }))
    fs.unlinkSync(path.join(tmpDir, RESTORE_INTENT_FILE))
    fs.unlinkSync(path.join(tmpDir, RESTORE_STAGING_DIR, 'settings.json'))

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'partial-boot-3',
    })).not.toThrow()
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(
      fs.readFileSync(path.join(snapshot.snapshot, 'settings.json')),
    )
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(snapshot.journal)
  })

  it('resets untrusted non-primary orphan controls and repeats two independent Windows confirmations', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(125)])
    const original = writeCorruptLivePair(tmpDir)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'orphan-boot-0' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    fs.unlinkSync(path.join(tmpDir, RESTORE_INTENT_FILE))
    const metadataPath = path.join(tmpDir, RESTORE_STAGING_DIR, 'restore-transaction.json')
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    metadata.phase = 'awaiting-windows-confirmation'
    metadata.windowsVerifiedStartups = 2
    metadata.lastWindowsStartupId = 'forged-orphan'
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'orphan-boot-1' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8'))).toMatchObject({
      phase: 'awaiting-windows-confirmation',
      windowsVerifiedStartups: 0,
      lastWindowsStartupId: 'orphan-boot-1',
    })
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)

    expect(() => recoverSettingsAndJournalPair(tmpDir, { platform: 'win32', startupId: 'orphan-boot-2' }))
      .toThrow(expect.objectContaining({ restartRequired: true }))
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(original.settings)

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'orphan-boot-3',
    })).toThrow(expect.objectContaining({ restartRequired: true, restoreApplied: true }))
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(
      fs.readFileSync(path.join(snapshot.snapshot, 'settings.json')),
    )
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

  it('recovers production POSIX orphan staging after intent deletion and a cleanup crash', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(149)])
    writeCorruptLivePair(tmpDir)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const posixOps = simulatedPosixOps()
    let failAfterIntentDeletion = true
    const durableFs: DurableFileOps = {
      ...posixOps,
      unlinkSync(target) {
        posixOps.unlinkSync(target)
        if (failAfterIntentDeletion
          && path.resolve(String(target)) === path.resolve(path.join(tmpDir, RESTORE_INTENT_FILE))) {
          failAfterIntentDeletion = false
          throw new Error('simulated POSIX crash after intent deletion')
        }
      },
    }

    expect(() => new SettingsStore(tmpDir, { platform: 'linux', durableFs }))
      .toThrow(/simulated POSIX crash after intent deletion/i)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
    expect(fs.existsSync(stagingPath)).toBe(true)

    expect(() => new SettingsStore(tmpDir, { platform: 'linux', durableFs })).not.toThrow()
    expect(fs.existsSync(stagingPath)).toBe(false)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(
      fs.readFileSync(path.join(snapshot.snapshot, 'settings.json')),
    )
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(snapshot.journal)
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

    const restored = new SettingsStore(tmpDir, { platform: 'linux', durableFs: simulatedPosixOps() })
    expect(restored.get().baby.name).toBe(newer.settings.baby.name)
  })

  it('restores a Documents-only verified snapshot from the configured second root', () => {
    const documentsParent = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-documents-backup-'))
    try {
      const snapshot = writeSnapshot(documentsParent, '2026-07-13_10-20-30', [mutation(6)])
      writeCorruptLivePair(tmpDir)

      const restored = new SettingsStore(tmpDir, {
        documentsBackupDir: path.join(documentsParent, 'backups'),
        platform: 'linux',
        durableFs: simulatedPosixOps(),
      })
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
        platform: 'linux',
        durableFs: simulatedPosixOps(),
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

    const restored = new SettingsStore(tmpDir, { platform: 'linux', durableFs: simulatedPosixOps() })
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

    const restored = new SettingsStore(tmpDir, { platform: 'linux', durableFs: simulatedPosixOps() })

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

    const restored = new SettingsStore(tmpDir, { platform: 'linux', durableFs: simulatedPosixOps() })

    expect(restored.get().baby.name).toBe('Legacy')
    expect(restored.getBabyInfoSummary('legacy-family')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
    })
  })

  it('bounds manifest-less legacy snapshot enumeration before validating its exact shape', () => {
    const snapshot = path.join(tmpDir, 'backups', '2025-01-01_00-00-00')
    fs.mkdirSync(snapshot, { recursive: true })
    fs.writeFileSync(path.join(snapshot, 'settings.json'), '{}', 'utf8')
    for (let index = 0; index < 8; index += 1) {
      fs.writeFileSync(path.join(snapshot, `hostile-${index}.bin`), 'noise')
    }

    expect(() => verifyBackupSnapshot(snapshot))
      .toThrow(/legacy backup entry count exceeds its configured bound/i)
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

      const restored = new SettingsStore(tmpDir, { platform: 'linux', durableFs: simulatedPosixOps() })
      expect(restored.get().baby.name).toBe(snapshot.settings.baby.name)
      expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(settingsBytes)
      expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(journalBytes)
      expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
      expect(fs.existsSync(staging)).toBe(false)
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
