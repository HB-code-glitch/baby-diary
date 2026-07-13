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

interface SyntheticMaximumJournal {
  size: number
  sha256: string
  readInto(target: Buffer, offset: number, length: number, position: number): number
}

function syntheticMaximumJournal(prefix: Buffer): SyntheticMaximumJournal {
  const size = 128 * 1024 * 1024
  if (prefix.byteLength === 0 || prefix.at(-1) !== 0x0a) {
    throw new Error('synthetic journal prefix must be a non-empty terminated journal')
  }
  const importJson = Buffer.from('{"version":1,"type":"import","sourceId":"maximum-stream"}', 'utf8')
  const makeImportLine = (lineSize: number): Buffer => Buffer.concat([
    importJson,
    Buffer.alloc(lineSize - importJson.byteLength - 1, 0x20),
    Buffer.from('\n'),
  ], lineSize)
  const fullLine = makeImportLine(64 * 1024)
  const tailBytes = size - prefix.byteLength
  let fullLineCount = Math.floor(tailBytes / fullLine.byteLength)
  let finalLineSize = tailBytes - (fullLineCount * fullLine.byteLength)
  if (finalLineSize > 0 && finalLineSize < importJson.byteLength + 1) {
    fullLineCount -= 1
    finalLineSize += fullLine.byteLength
  }
  const finalLine = finalLineSize > 0 ? makeImportLine(finalLineSize) : Buffer.alloc(0)
  const fullLineRegionBytes = fullLineCount * fullLine.byteLength
  const hash = createHash('sha256').update(prefix)
  for (let index = 0; index < fullLineCount; index += 1) hash.update(fullLine)
  if (finalLine.byteLength > 0) hash.update(finalLine)

  return {
    size,
    sha256: hash.digest('hex'),
    readInto(target, offset, length, position) {
      let sourcePosition = position
      let targetOffset = offset
      let remaining = length
      while (remaining > 0) {
        if (sourcePosition < prefix.byteLength) {
          const count = Math.min(remaining, prefix.byteLength - sourcePosition)
          prefix.copy(target, targetOffset, sourcePosition, sourcePosition + count)
          sourcePosition += count
          targetOffset += count
          remaining -= count
          continue
        }

        const tailPosition = sourcePosition - prefix.byteLength
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
        if (count <= 0) throw new Error('synthetic journal read exceeded EOF')
        finalLine.copy(target, targetOffset, finalOffset, finalOffset + count)
        sourcePosition += count
        targetOffset += count
        remaining -= count
      }
      return length
    },
  }
}

function guardBufferAllocations(
  maximum: number,
  action: () => void,
): Array<{ method: string; size: number }> {
  const allocations: Array<{ method: string; size: number }> = []
  const originalAlloc = Buffer.alloc
  const originalAllocUnsafe = Buffer.allocUnsafe
  const originalFrom = Buffer.from
  const originalConcat = Buffer.concat
  const record = (method: string, size: number): void => {
    allocations.push({ method, size })
    if (size > maximum) throw new Error(`oversized Buffer.${method}: ${size}`)
  }
  const allocSpy = vi.spyOn(Buffer, 'alloc').mockImplementation(((
    size: number,
    fill?: string | number | Uint8Array,
    encoding?: BufferEncoding,
  ): Buffer => {
    record('alloc', size)
    if (fill === undefined) return originalAlloc(size)
    if (encoding === undefined) return originalAlloc(size, fill)
    return originalAlloc(size, fill as string, encoding)
  }) as typeof Buffer.alloc)
  const allocUnsafeSpy = vi.spyOn(Buffer, 'allocUnsafe').mockImplementation(((size: number): Buffer => {
    record('allocUnsafe', size)
    return originalAllocUnsafe(size)
  }) as typeof Buffer.allocUnsafe)
  const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((...args: unknown[]): Buffer => {
    const [value, second, third] = args
    let size: number
    if (typeof value === 'string') {
      size = Buffer.byteLength(value, typeof second === 'string' ? second as BufferEncoding : undefined)
    } else if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      const offset = typeof second === 'number' ? second : 0
      size = typeof third === 'number' ? third : value.byteLength - offset
    } else {
      const candidate = value as { byteLength?: number; length?: number }
      size = candidate?.byteLength ?? candidate?.length ?? 0
    }
    record('from', size)
    return (originalFrom as (...input: unknown[]) => Buffer)(...args)
  }) as typeof Buffer.from)
  const concatSpy = vi.spyOn(Buffer, 'concat').mockImplementation(((
    list: readonly Uint8Array[],
    totalLength?: number,
  ): Buffer => {
    const size = totalLength ?? list.reduce((total, item) => total + item.byteLength, 0)
    record('concat', size)
    return originalConcat(list, totalLength)
  }) as typeof Buffer.concat)
  try {
    action()
  } finally {
    concatSpy.mockRestore()
    fromSpy.mockRestore()
    allocUnsafeSpy.mockRestore()
    allocSpy.mockRestore()
  }
  return allocations
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

function prepareMaximumCompletedRestore(
  root: string,
  index: number,
  bootPrefix: string,
  advanceSettings: boolean,
): {
  fixture: SyntheticMaximumJournal
  intentPath: string
  expectedProfileName: string
  expectedJournalFiles: number
} {
  const completed = reachPrimaryVerifiedWindowsRestore(root, index, bootPrefix)
  let expectedProfileName = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).profile.name
  if (advanceSettings) {
    const settingsPath = path.join(root, 'settings.json')
    const before = fs.readFileSync(settingsPath)
    const settings = JSON.parse(before.toString('utf8')) as AppSettings
    settings.profile.name = 'Keeper'
    const after = Buffer.from(JSON.stringify(settings, null, 2), 'utf8')
    expect(after.byteLength).toBe(before.byteLength)
    fs.writeFileSync(settingsPath, after)
    expectedProfileName = settings.profile.name
  }

  const snapshotPath = path.join(root, 'backups', '2026-07-13_10-20-30')
  const snapshotJournalPath = path.join(snapshotPath, BABY_INFO_JOURNAL_FILE)
  const liveJournalPath = path.join(root, BABY_INFO_JOURNAL_FILE)
  const prefix = fs.readFileSync(snapshotJournalPath)
  expect(fs.readFileSync(liveJournalPath)).toEqual(prefix)
  const fixture = syntheticMaximumJournal(prefix)
  fs.truncateSync(snapshotJournalPath, fixture.size)
  fs.truncateSync(liveJournalPath, fixture.size)
  const stagingPath = path.join(root, RESTORE_STAGING_DIR)
  if (fs.existsSync(stagingPath)) {
    fs.truncateSync(path.join(stagingPath, BABY_INFO_JOURNAL_FILE), fixture.size)
  }

  const manifestPath = path.join(snapshotPath, MANIFEST_FILE)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const journalEntry = manifest.files.find((entry: { path: string }) => entry.path === BABY_INFO_JOURNAL_FILE)
  journalEntry.size = fixture.size
  journalEntry.sha256 = fixture.sha256
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  const transaction = JSON.parse(completed.staleIntent.toString('utf8'))
  transaction.journal = { size: fixture.size, sha256: fixture.sha256 }
  const intentPath = path.join(root, RESTORE_INTENT_FILE)
  fs.writeFileSync(intentPath, JSON.stringify(transaction, null, 2), 'utf8')
  if (fs.existsSync(stagingPath)) {
    fs.writeFileSync(
      path.join(stagingPath, 'restore-transaction.json'),
      JSON.stringify(transaction, null, 2),
      'utf8',
    )
  }
  return {
    fixture,
    intentPath,
    expectedProfileName,
    expectedJournalFiles: fs.existsSync(stagingPath) ? 3 : 2,
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

  it('accepts the legacy 4096-file production boundary', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(233)])
    for (let index = 0; index < 4_093; index += 1) {
      fs.writeFileSync(
        path.join(snapshot.snapshot, 'data', `boundary-${String(index).padStart(4, '0')}.jsonl`),
        '{}\n',
      )
    }
    writeManifest(snapshot.snapshot)

    expect(() => verifyBackupSnapshot(snapshot.snapshot)).not.toThrow()
    const moved = `${snapshot.snapshot}-moved`
    fs.renameSync(snapshot.snapshot, moved)
    fs.renameSync(moved, snapshot.snapshot)
  })

  it('verifies 128 manifest files with at most four evidence handles open', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(234)])
    for (let index = 0; index < 125; index += 1) {
      fs.writeFileSync(
        path.join(snapshot.snapshot, 'data', `bounded-${String(index).padStart(3, '0')}.jsonl`),
        '{}\n',
      )
    }
    writeManifest(snapshot.snapshot)

    const realOpen = fs.openSync.bind(fs)
    const realClose = fs.closeSync.bind(fs)
    const held = new Set<number>()
    let peak = 0
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target, flags, mode) {
        const fd = realOpen(target, flags, mode)
        held.add(fd)
        peak = Math.max(peak, held.size)
        return fd
      },
      closeSync(fd) {
        realClose(fd)
        held.delete(fd)
      },
    }

    expect(() => verifyBackupSnapshot(snapshot.snapshot, {
      durableFs,
    } as Parameters<typeof verifyBackupSnapshot>[1] & { durableFs: DurableFileOps })).not.toThrow()
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(4)
    expect(held.size).toBe(0)
  })

  it('rejects 4097 manifest files and leaves no handle behind', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(237)])
    for (let index = 0; index < 4_094; index += 1) {
      fs.writeFileSync(
        path.join(snapshot.snapshot, 'data', `overflow-${String(index).padStart(4, '0')}.jsonl`),
        '{}\n',
      )
    }
    writeManifest(snapshot.snapshot)

    expect(() => verifyBackupSnapshot(snapshot.snapshot)).toThrow(/file.?count|too many/i)
    const moved = `${snapshot.snapshot}-moved`
    fs.renameSync(snapshot.snapshot, moved)
    fs.renameSync(moved, snapshot.snapshot)
  })

  it('preserves a cleanup-complete evidence spool owned by a foreign startup', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(243)])
    fs.copyFileSync(path.join(snapshot.snapshot, 'settings.json'), path.join(tmpDir, 'settings.json'))
    fs.copyFileSync(
      path.join(snapshot.snapshot, BABY_INFO_JOURNAL_FILE),
      path.join(tmpDir, BABY_INFO_JOURNAL_FILE),
    )
    const stalePid = process.pid === 999_999 ? 999_998 : 999_999
    const spool = path.join(
      tmpDir,
      'backups',
      `.baby-info-backup.tmp-evidence-${stalePid}-crashproof`,
    )
    fs.mkdirSync(path.join(spool, 'data'), { recursive: true })
    const spoolStat = fs.statSync(spool)
    fs.writeFileSync(path.join(spool, '.baby-info-backup-evidence-v1.json'), JSON.stringify({
      version: 1,
      spoolId: path.basename(spool),
      snapshotId: '2026-07-13_10-20-30',
      ownerPid: stalePid,
      startupId: 'foreign-startup',
      transactionDigest: '3'.repeat(64),
      root: {
        dev: spoolStat.dev,
        ino: spoolStat.ino,
        birthtimeMs: spoolStat.birthtimeMs,
      },
      state: 'cleanup-complete',
      sealedDigest: '4'.repeat(64),
    }), 'utf8')
    fs.writeFileSync(path.join(spool, BABY_INFO_JOURNAL_FILE), snapshot.journal)
    fs.writeFileSync(path.join(spool, 'data', '2026-07.jsonl'), '{"sealed":true}\n')

    recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'stale-spool-cleanup',
    })

    expect(fs.existsSync(spool)).toBe(true)
  })

  it('preserves a cleanup-complete spool when its durable marker response is lost', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(244)])
    let markerPublications = 0
    const durableFs: DurableFileOps = {
      ...fs,
      renameSync(source, destination) {
        fs.renameSync(source, destination)
        if (path.basename(String(destination)) === '.baby-info-backup-evidence-v1.json') {
          markerPublications += 1
          if (markerPublications === 2) {
            throw new Error('simulated response loss after cleanup-complete marker publish')
          }
        }
      },
    }

    expect(() => verifyBackupSnapshot(snapshot.snapshot, {
      platform: 'win32',
      durableFs,
      startupId: 'response-loss-startup',
    } as Parameters<typeof verifyBackupSnapshot>[1] & { startupId: string }))
      .toThrow(/response loss after cleanup-complete marker publish/i)
    expect(markerPublications).toBe(2)
    const spools = fs.readdirSync(path.dirname(snapshot.snapshot))
      .filter(name => name.startsWith('.baby-info-backup.tmp-evidence-'))
    expect(spools).toHaveLength(1)
    const marker = JSON.parse(fs.readFileSync(path.join(
      path.dirname(snapshot.snapshot),
      spools[0],
      '.baby-info-backup-evidence-v1.json',
    ), 'utf8'))
    expect(marker.state).toBe('cleanup-complete')
  })

  it('preserves an active evidence spool from an unconfirmed startup', () => {
    const backups = path.join(tmpDir, 'backups')
    fs.mkdirSync(backups)
    const spool = path.join(backups, '.baby-info-backup.tmp-evidence-999999-activeproof')
    fs.mkdirSync(spool)
    const root = fs.statSync(spool)
    fs.writeFileSync(path.join(spool, '.baby-info-backup-evidence-v1.json'), JSON.stringify({
      version: 1,
      spoolId: path.basename(spool),
      snapshotId: '2026-07-13_10-20-30',
      ownerPid: 999_999,
      startupId: 'unconfirmed-startup',
      transactionDigest: '5'.repeat(64),
      root: { dev: root.dev, ino: root.ino, birthtimeMs: root.birthtimeMs },
      state: 'active',
      sealedDigest: null,
    }), 'utf8')
    const live = mutation(245)
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(settingsFor(live), null, 2))
    const journal = new BabyInfoJournal(tmpDir)
    journal.ingest(live.familyId, [live], [])

    recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'different-startup',
    })

    expect(fs.existsSync(spool)).toBe(true)
  })

  it('refuses cleanup when the cleanup-complete marker is atomically swapped', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(246)])
    let markerPublications = 0
    let spool = ''
    const durableFs: DurableFileOps = {
      ...fs,
      renameSync(source, destination) {
        fs.renameSync(source, destination)
        if (path.basename(String(destination)) === '.baby-info-backup-evidence-v1.json') {
          markerPublications += 1
          if (markerPublications === 2) {
            spool = path.dirname(String(destination))
            const marker = JSON.parse(fs.readFileSync(destination, 'utf8'))
            marker.snapshotId = 'swapped-marker-authority'
            const replacement = `${String(destination)}.swapped`
            fs.writeFileSync(replacement, JSON.stringify(marker), 'utf8')
            fs.renameSync(replacement, destination)
          }
        }
      },
    }

    expect(() => verifyBackupSnapshot(snapshot.snapshot, {
      platform: 'win32',
      durableFs,
      startupId: 'marker-swap-startup',
    } as Parameters<typeof verifyBackupSnapshot>[1] & { startupId: string }))
      .toThrow(/marker|evidence|authority|identity|changed/i)
    expect(markerPublications).toBe(2)
    expect(fs.existsSync(spool)).toBe(true)
  })

  it('refuses cleanup when the same spool name is recreated with a new root inode', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(247)])
    let markerPublications = 0
    let spool = ''
    let displaced = ''
    const durableFs: DurableFileOps = {
      ...fs,
      renameSync(source, destination) {
        fs.renameSync(source, destination)
        if (path.basename(String(destination)) === '.baby-info-backup-evidence-v1.json') {
          markerPublications += 1
          if (markerPublications === 2) {
            spool = path.dirname(String(destination))
            displaced = `${spool}.replayed-root`
            fs.renameSync(spool, displaced)
            fs.mkdirSync(spool)
            fs.copyFileSync(
              path.join(displaced, '.baby-info-backup-evidence-v1.json'),
              path.join(spool, '.baby-info-backup-evidence-v1.json'),
            )
          }
        }
      },
    }

    expect(() => verifyBackupSnapshot(snapshot.snapshot, {
      platform: 'win32',
      durableFs,
      startupId: 'root-replay-startup',
    } as Parameters<typeof verifyBackupSnapshot>[1] & { startupId: string }))
      .toThrow(/spool|evidence|identity|changed/i)
    expect(markerPublications).toBe(2)
    expect(fs.existsSync(spool)).toBe(true)
    expect(fs.existsSync(displaced)).toBe(true)
  })

  it('deletes only the isolated spool tombstone when its original name is reused', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(249)])
    let isolated = false
    let reusedRoot = ''
    const durableFs: DurableFileOps = {
      ...fs,
      renameSync(source, destination) {
        fs.renameSync(source, destination)
        const sourceName = path.basename(String(source))
        if (!isolated
          && sourceName.startsWith('.baby-info-backup.tmp-evidence-')
          && path.basename(String(destination)).startsWith(`${sourceName}.cleanup-`)) {
          isolated = true
          reusedRoot = String(source)
          fs.mkdirSync(reusedRoot)
          fs.writeFileSync(path.join(reusedRoot, 'new-owner.txt'), 'keep me', 'utf8')
        }
      },
    }

    verifyBackupSnapshot(snapshot.snapshot, {
      platform: 'win32',
      durableFs,
      startupId: 'spool-name-reuse-startup',
    } as Parameters<typeof verifyBackupSnapshot>[1] & { startupId: string })

    expect(isolated).toBe(true)
    expect(fs.readFileSync(path.join(reusedRoot, 'new-owner.txt'), 'utf8')).toBe('keep me')
    expect(fs.readdirSync(path.dirname(snapshot.snapshot)).filter(name => (
      name.startsWith('.baby-info-backup.tmp-evidence-') && name.includes('.cleanup-')
    ))).toEqual([])
  })

  it('preserves an isolated spool tombstone when strict inventory gains an unexpected entry', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(250)])
    let cleanupRoot = ''
    const durableFs: DurableFileOps = {
      ...fs,
      renameSync(source, destination) {
        fs.renameSync(source, destination)
        const sourceName = path.basename(String(source))
        if (!cleanupRoot
          && sourceName.startsWith('.baby-info-backup.tmp-evidence-')
          && path.basename(String(destination)).startsWith(`${sourceName}.cleanup-`)) {
          cleanupRoot = String(destination)
          fs.writeFileSync(path.join(cleanupRoot, 'unexpected.txt'), 'foreign evidence', 'utf8')
        }
      },
    }

    expect(() => verifyBackupSnapshot(snapshot.snapshot, {
      platform: 'win32',
      durableFs,
      startupId: 'spool-unexpected-entry-startup',
    } as Parameters<typeof verifyBackupSnapshot>[1] & { startupId: string }))
      .toThrow(/inventory|unexpected|sealed|evidence/i)
    expect(cleanupRoot).not.toBe('')
    expect(fs.readFileSync(path.join(cleanupRoot, 'unexpected.txt'), 'utf8'))
      .toBe('foreign evidence')
  })

  it('preserves an isolated spool tombstone when sealed evidence is replaced by a hard link', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(251)])
    const foreignJournal = path.join(tmpDir, 'foreign-linked-journal.jsonl')
    fs.writeFileSync(foreignJournal, snapshot.journal)
    let cleanupRoot = ''
    const durableFs: DurableFileOps = {
      ...fs,
      renameSync(source, destination) {
        fs.renameSync(source, destination)
        const sourceName = path.basename(String(source))
        if (!cleanupRoot
          && sourceName.startsWith('.baby-info-backup.tmp-evidence-')
          && path.basename(String(destination)).startsWith(`${sourceName}.cleanup-`)) {
          cleanupRoot = String(destination)
          const sealedJournal = path.join(cleanupRoot, BABY_INFO_JOURNAL_FILE)
          fs.unlinkSync(sealedJournal)
          fs.linkSync(foreignJournal, sealedJournal)
        }
      },
    }

    expect(() => verifyBackupSnapshot(snapshot.snapshot, {
      platform: 'win32',
      durableFs,
      startupId: 'spool-linked-entry-startup',
    } as Parameters<typeof verifyBackupSnapshot>[1] & { startupId: string }))
      .toThrow(/identity|inventory|sealed|evidence/i)
    expect(cleanupRoot).not.toBe('')
    expect(fs.existsSync(cleanupRoot)).toBe(true)
    expect(fs.existsSync(foreignJournal)).toBe(true)
    expect(fs.statSync(path.join(cleanupRoot, BABY_INFO_JOURNAL_FILE)).ino)
      .toBe(fs.statSync(foreignJournal).ino)
  })

  it('reserves a 128-bit cleanup name and preserves both roots on a destination collision', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(252)])
    const realOpen = fs.openSync.bind(fs)
    let reservation = ''
    let cleanupRoot = ''
    let originalRoot = ''
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target, flags, mode) {
        const candidate = String(target)
        if (!reservation
          && candidate.includes('.baby-info-backup.tmp-evidence-')
          && /\.cleanup-[0-9a-f]{32}\.reserve$/i.test(candidate)) {
          reservation = candidate
          cleanupRoot = candidate.slice(0, -'.reserve'.length)
          originalRoot = cleanupRoot.replace(/\.cleanup-[0-9a-f]{32}$/i, '')
          fs.mkdirSync(cleanupRoot)
          expect(flags).toBe('wx')
        }
        return realOpen(target, flags, mode)
      },
    }

    expect(() => verifyBackupSnapshot(snapshot.snapshot, {
      platform: 'win32',
      durableFs,
      startupId: 'spool-cleanup-collision-startup',
    } as Parameters<typeof verifyBackupSnapshot>[1] & { startupId: string }))
      .toThrow(/cleanup|collision|already exists|destination/i)
    expect(reservation).toMatch(/\.cleanup-[0-9a-f]{32}\.reserve$/i)
    expect(fs.existsSync(reservation)).toBe(true)
    expect(fs.existsSync(cleanupRoot)).toBe(true)
    expect(fs.existsSync(originalRoot)).toBe(true)
  })

  it('refuses cleanup when sealed data is replaced by a directory symlink', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(248)])
    let markerPublications = 0
    let spool = ''
    const durableFs: DurableFileOps = {
      ...fs,
      renameSync(source, destination) {
        fs.renameSync(source, destination)
        if (path.basename(String(destination)) === '.baby-info-backup-evidence-v1.json') {
          markerPublications += 1
          if (markerPublications === 2) {
            spool = path.dirname(String(destination))
            const data = path.join(spool, 'data')
            const displaced = path.join(spool, 'data-real')
            fs.renameSync(data, displaced)
            fs.symlinkSync(displaced, data, 'junction')
          }
        }
      },
    }

    expect(() => verifyBackupSnapshot(snapshot.snapshot, {
      platform: 'win32',
      durableFs,
      startupId: 'symlink-spool-startup',
    } as Parameters<typeof verifyBackupSnapshot>[1] & { startupId: string }))
      .toThrow(/spool|evidence|identity|changed|escaped/i)
    expect(markerPublications).toBe(2)
    expect(fs.existsSync(spool)).toBe(true)
    expect(fs.lstatSync(path.join(spool, 'data')).isSymbolicLink()).toBe(true)
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
          fs.rmSync(resolved, { recursive: true, force: true })
          fs.symlinkSync(outside, resolved, process.platform === 'win32' ? 'junction' : 'dir')
          swapped = true
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

  it.each([
    ['same-inode rewrite', 'rewrite'],
    ['same-inode short write', 'short-write'],
    ['atomic path swap', 'swap'],
  ] as const)(
    'keeps POSIX primaries untouched when the forensic journal suffers a %s immediately before publication',
    (_label, mutationKind) => {
      writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(253)])
      const original = writeCorruptLivePair(tmpDir)
      const settingsPath = path.join(tmpDir, 'settings.json')
      const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
      const base = simulatedPosixOps()
      const targets = new Map<number, string>()
      const primaryRenames: string[] = []
      let mutated = false
      let swapBlockedByLease = false
      let leaseHeldAtPublication = false
      let forensicJournal = ''
      let forensicBefore: fs.Stats | undefined
      const durableFs: DurableFileOps = {
        ...base,
        openSync(target, flags, mode) {
          const fd = base.openSync(target, flags, mode)
          targets.set(fd, path.resolve(String(target)))
          return fd
        },
        fsyncSync(fd) {
          base.fsyncSync(fd)
          const target = targets.get(fd) ?? ''
          if (!mutated
            && path.dirname(target) === path.resolve(tmpDir)
            && path.basename(target).startsWith('settings.json.tmp-')) {
            const forensicRoot = path.join(tmpDir, 'recovery-forensics')
            const archive = path.join(forensicRoot, fs.readdirSync(forensicRoot)[0])
            forensicJournal = path.join(archive, BABY_INFO_JOURNAL_FILE)
            forensicBefore = fs.statSync(forensicJournal)
            leaseHeldAtPublication = Array.from(targets.entries()).some(([openFd, openedPath]) => {
              if (openedPath !== path.resolve(forensicJournal) || openFd === fd) return false
              const opened = fs.fstatSync(openFd)
              return opened.dev === forensicBefore!.dev && opened.ino === forensicBefore!.ino
            })
            const bytes = fs.readFileSync(forensicJournal)
            if (mutationKind === 'swap') {
              const replacement = path.join(tmpDir, '.forensic-precommit-journal-swap')
              const changed = Buffer.from(bytes)
              changed[0] = changed[0] === 0x58 ? 0x59 : 0x58
              fs.writeFileSync(replacement, changed)
              try {
                fs.renameSync(replacement, forensicJournal)
              } catch (error) {
                if (process.platform !== 'win32'
                  || !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                  throw error
                }
                swapBlockedByLease = true
                throw new Error('atomic forensic path swap was blocked by the held lease')
              }
            } else if (mutationKind === 'short-write') {
              const journalFd = fs.openSync(forensicJournal, 'r+')
              try {
                expect(fs.writeSync(journalFd, Buffer.from('X'), 0, 1, 0)).toBe(1)
                fs.fsyncSync(journalFd)
              } finally {
                fs.closeSync(journalFd)
              }
            } else {
              const changed = Buffer.from(bytes)
              changed[0] = changed[0] === 0x58 ? 0x59 : 0x58
              fs.writeFileSync(forensicJournal, changed)
            }
            mutated = true
          }
        },
        renameSync(source, destination) {
          const resolved = path.resolve(String(destination))
          if (resolved === path.resolve(settingsPath) || resolved === path.resolve(journalPath)) {
            primaryRenames.push(resolved)
          }
          base.renameSync(source, destination)
        },
        closeSync(fd) {
          targets.delete(fd)
          base.closeSync(fd)
        },
      }

      const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
        platform: 'linux',
        durableFs,
        startupId: `forensic-precommit-${mutationKind}`,
      }))

      expect.soft(mutated || swapBlockedByLease).toBe(true)
      expect.soft(leaseHeldAtPublication).toBe(true)
      expect.soft(error.message).toMatch(/forensic|preserv|changed|checksum|identity/i)
      expect.soft(error).toMatchObject({
        code: 'SETTINGS_RECOVERY_REQUIRED',
        originalsPreserved: swapBlockedByLease,
        primaryUntouched: true,
      })
      expect.soft(primaryRenames).toEqual([])
      expect.soft(fs.readFileSync(settingsPath)).toEqual(original.settings)
      expect.soft(fs.readFileSync(journalPath)).toEqual(original.journal)
      expect(fs.existsSync(forensicJournal)).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)
      const forensicAfter = fs.statSync(forensicJournal)
      if (mutationKind === 'swap' && !swapBlockedByLease) {
        expect(forensicAfter.ino).not.toBe(forensicBefore!.ino)
      } else {
        expect(forensicAfter.ino).toBe(forensicBefore!.ino)
      }
      expect(targets.size).toBe(0)
    },
  )

  it('resumes from held forensic evidence after the first POSIX primary rename loses its response', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(254)])
    const original = writeCorruptLivePair(tmpDir)
    const settingsPath = path.join(tmpDir, 'settings.json')
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const posixOps = simulatedPosixOps()
    let responseLost = false
    const uncertainOps: DurableFileOps = {
      ...posixOps,
      renameSync(source, destination) {
        posixOps.renameSync(source, destination)
        if (!responseLost && path.resolve(String(destination)) === path.resolve(settingsPath)) {
          responseLost = true
          throw new Error('simulated response loss after first primary rename')
        }
      },
    }

    const first = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'linux',
      durableFs: uncertainOps,
      startupId: 'partial-primary-response-loss',
    }))
    expect(responseLost).toBe(true)
    expect(first.message).toMatch(/response loss after first primary rename/i)
    expect(first).toMatchObject({ originalsPreserved: true, primaryUntouched: false })
    expect(fs.readFileSync(settingsPath)).toEqual(
      fs.readFileSync(path.join(snapshot.snapshot, 'settings.json')),
    )
    expect(fs.readFileSync(journalPath)).toEqual(original.journal)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    const forensicArchive = path.join(forensicRoot, fs.readdirSync(forensicRoot)[0])
    expect(fs.readFileSync(path.join(forensicArchive, 'settings.json'))).toEqual(original.settings)
    expect(fs.readFileSync(path.join(forensicArchive, BABY_INFO_JOURNAL_FILE))).toEqual(original.journal)

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'linux',
      durableFs: posixOps,
      startupId: 'partial-primary-retry',
    })).not.toThrow()
    expect(fs.readFileSync(settingsPath)).toEqual(
      fs.readFileSync(path.join(snapshot.snapshot, 'settings.json')),
    )
    expect(fs.readFileSync(journalPath)).toEqual(snapshot.journal)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)
  })

  it('never preserves an A-settings/B-journal mixture when both live files change at the open seam', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(228)])
    const settingsPath = path.join(tmpDir, 'settings.json')
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const settingsA = Buffer.from('{ corrupt-settings-A', 'utf8')
    const settingsB = Buffer.from('{ corrupt-settings-B', 'utf8')
    const journalA = Buffer.from('{"broken-journal":"A"', 'utf8')
    const journalB = Buffer.from('{"broken-journal":"B"', 'utf8')
    expect(settingsB.byteLength).toBe(settingsA.byteLength)
    expect(journalB.byteLength).toBe(journalA.byteLength)
    fs.writeFileSync(settingsPath, settingsA)
    fs.writeFileSync(journalPath, journalA)

    const realNative = fs.realpathSync.native.bind(fs.realpathSync)
    let changed = false
    let userDataRootRealpaths = 0
    const realpathSpy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((target: fs.PathLike): string => {
      if (path.resolve(String(target)) === path.resolve(tmpDir)) userDataRootRealpaths += 1
      if (!changed && userDataRootRealpaths === 3) {
        const settingsFd = fs.openSync(settingsPath, 'r+')
        const journalFd = fs.openSync(journalPath, 'r+')
        try {
          expect(fs.writeSync(settingsFd, settingsB, 0, settingsB.byteLength, 0))
            .toBe(settingsB.byteLength)
          expect(fs.writeSync(journalFd, journalB, 0, journalB.byteLength, 0))
            .toBe(journalB.byteLength)
          changed = true
        } finally {
          fs.closeSync(journalFd)
          fs.closeSync(settingsFd)
        }
      }
      return realNative(target)
    }) as typeof fs.realpathSync.native)

    let error: Error & Record<string, unknown>
    try {
      error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
        platform: 'win32',
        startupId: 'mixed-forensic-source-boot-0',
      }))
    } finally {
      realpathSpy.mockRestore()
    }
    expect(changed).toBe(true)
    expect(error!.message).toMatch(/forensic preservation|settings|changed|identity/i)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(false)
    expect(fs.readFileSync(settingsPath)).toEqual(settingsB)
    expect(fs.readFileSync(journalPath)).toEqual(journalB)
    expect(forensicFootprint(tmpDir).archives).toBe(0)
  })

  it('streams a 128 MiB live forensic source with short reads and bounded allocations', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(231)])
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ corrupt-live-settings')
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const prefix = fs.readFileSync(path.join(snapshot.snapshot, BABY_INFO_JOURNAL_FILE))
    const fixture = syntheticMaximumJournal(prefix)
    fs.writeFileSync(journalPath, prefix)
    fs.truncateSync(journalPath, fixture.size)
    const journalIdentity = fs.statSync(journalPath)
    const reads: Array<{ position: number; requested: number; returned: number }> = []
    const durableFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        if (position === null) throw new Error('forensic source reads must be positional')
        const opened = fs.fstatSync(fd)
        if (opened.dev === journalIdentity.dev && opened.ino === journalIdentity.ino) {
          const returned = Math.min(length, 32 * 1024)
          const target = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          fixture.readInto(target, offset, returned, position)
          reads.push({ position, requested: length, returned })
          return returned
        }
        return fs.readSync(fd, buffer, offset, length, position)
      },
    }

    let error: Error & Record<string, unknown> | undefined
    const startedAt = Date.now()
    const allocations = guardBufferAllocations(64 * 1024, () => {
      error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
        platform: 'win32',
        startupId: 'forensic-maximum-source-boot-0',
        durableFs,
      }))
    })
    const elapsedMs = Date.now() - startedAt

    expect(error).toMatchObject({ restartRequired: true, primaryUntouched: true })
    expect(Math.max(...allocations.map(allocation => allocation.size))).toBeLessThanOrEqual(64 * 1024)
    expect(reads.some(read => read.returned < read.requested)).toBe(true)
    expect(Math.max(...reads.map(read => read.requested))).toBeLessThanOrEqual(64 * 1024)
    expect(reads.reduce((total, read) => total + read.returned, 0)).toBe(fixture.size * 3)
    expect(reads.filter(read => read.position + read.returned === fixture.size)).toHaveLength(3)
    expect(elapsedMs).toBeLessThan(20_000)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_STAGING_DIR))).toBe(true)
    const forensicRoot = path.join(tmpDir, 'recovery-forensics')
    const archive = path.join(forensicRoot, fs.readdirSync(forensicRoot)[0])
    expect(fs.statSync(path.join(archive, BABY_INFO_JOURNAL_FILE)).size).toBe(fixture.size)
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

  it.each([
    ['exact restored pair', false, 150],
    ['same-size settings-only advancement', true, 151],
  ])('streams a maximum-size verified backup and %s without a whole-journal allocation', (
    label,
    advanceSettings,
    index,
  ) => {
    const bootPrefix = `maximum-${label.replaceAll(' ', '-')}`
    const prepared = prepareMaximumCompletedRestore(tmpDir, index, bootPrefix, advanceSettings)
    const journalPaths = new Map<string, string>([
      ['backup', path.join(tmpDir, 'backups', '2026-07-13_10-20-30', BABY_INFO_JOURNAL_FILE)],
      ['staging', path.join(tmpDir, RESTORE_STAGING_DIR, BABY_INFO_JOURNAL_FILE)],
      ['live', path.join(tmpDir, BABY_INFO_JOURNAL_FILE)],
    ].filter(([, target]) => fs.existsSync(target)).map(([source, target]) => {
      const identity = fs.statSync(target)
      return [`${identity.dev}:${identity.ino}`, source]
    }))
    const readRequests: Array<{ source: string; position: number; length: number }> = []
    const streamingFs: InstrumentedDurableFileOps = {
      ...fs,
      openSync(target, flags, mode) {
        const fd = fs.openSync(target, flags, mode)
        if (String(target).includes('.tmp-evidence-')
          && path.basename(String(target)) === BABY_INFO_JOURNAL_FILE) {
          const identity = fs.fstatSync(fd)
          journalPaths.set(`${identity.dev}:${identity.ino}`, 'sealed')
        }
        return fd
      },
      readSync(fd, buffer, offset, length, position) {
        if (position === null) throw new Error('maximum journal reads must be positional')
        const opened = fs.fstatSync(fd)
        if (opened.size !== prepared.fixture.size) {
          return fs.readSync(fd, buffer, offset, length, position)
        }
        const source = journalPaths.get(`${opened.dev}:${opened.ino}`)
        if (!source) throw new Error('unexpected maximum-size journal source')
        readRequests.push({ source, position, length })
        const target = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        return prepared.fixture.readInto(target, offset, length, position)
      },
    }

    const rssBefore = process.memoryUsage().rss
    const startedAt = Date.now()
    let allocations: Array<{ method: string; size: number }> = []
    expect(() => {
      allocations = guardBufferAllocations(64 * 1024, () => {
        recoverSettingsAndJournalPair(tmpDir, {
          platform: 'win32',
          startupId: `${bootPrefix}-boot-4`,
          durableFs: streamingFs,
        })
      })
    }).not.toThrow()
    const elapsedMs = Date.now() - startedAt
    const rssGrowthDiagnostic = Math.max(0, process.memoryUsage().rss - rssBefore)

    expect(Math.max(...allocations.map(allocation => allocation.size)), `RSS growth diagnostic only: ${rssGrowthDiagnostic}`)
      .toBeLessThanOrEqual(64 * 1024)
    expect(Math.max(...readRequests.map(request => request.length))).toBeLessThanOrEqual(64 * 1024)
    const expectedJournalPasses = prepared.expectedJournalFiles === 3 ? 14 : 9
    expect(readRequests.reduce((total, request) => total + request.length, 0))
      .toBe(prepared.fixture.size * expectedJournalPasses)
    expect(readRequests.filter(request => request.position + request.length === prepared.fixture.size))
      .toHaveLength(expectedJournalPasses)
    const eofCounts = Object.fromEntries(Array.from(journalPaths.values()).map(source => [
      source,
      readRequests.filter(request => (
        request.source === source
        && request.position + request.length === prepared.fixture.size
      )).length,
    ]))
    expect(eofCounts).toEqual(prepared.expectedJournalFiles === 3
      ? { backup: 5, staging: 2, live: 4, sealed: 3 }
      : { backup: 4, live: 3, sealed: 2 })
    expect(elapsedMs).toBeLessThan(10_000)
    expect(fs.existsSync(prepared.intentPath)).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8')).profile.name)
      .toBe(prepared.expectedProfileName)
  })

  it.each([
    ['same-inode same-size rewrite', false],
    ['same-path atomic replacement', true],
  ])('keeps settings held and rejects a %s during live journal replay', (label, replacePath) => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, replacePath ? 205 : 204, `settings-race-${label}`)
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const settingsPath = path.join(tmpDir, 'settings.json')
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const journalIdentity = fs.statSync(journalPath)
    const beforeJournal = fs.readFileSync(journalPath)
    const beforeSettings = fs.readFileSync(settingsPath)
    const changedSettings = JSON.parse(beforeSettings.toString('utf8')) as AppSettings
    changedSettings.profile.name = 'Keeper'
    const changedBytes = Buffer.from(JSON.stringify(changedSettings, null, 2), 'utf8')
    expect(changedBytes.byteLength).toBe(beforeSettings.byteLength)
    const stagedBefore = ['settings.json', BABY_INFO_JOURNAL_FILE, 'restore-transaction.json']
      .map(name => [name, fs.readFileSync(path.join(stagingPath, name))] as const)
    const temporary = path.join(tmpDir, '.settings-race-replacement')
    if (replacePath) fs.writeFileSync(temporary, changedBytes)

    let mutated = false
    let renameFailure: NodeJS.ErrnoException | undefined
    const durableFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        const count = fs.readSync(fd, buffer, offset, length, position)
        const opened = fs.fstatSync(fd)
        if (!mutated && opened.dev === journalIdentity.dev && opened.ino === journalIdentity.ino) {
          if (replacePath) {
            try {
              fs.renameSync(temporary, settingsPath)
              mutated = true
            } catch (error) {
              renameFailure = error as NodeJS.ErrnoException
              throw error
            }
          } else {
            const settingsFd = fs.openSync(settingsPath, 'r+')
            try {
              expect(fs.writeSync(settingsFd, changedBytes, 0, changedBytes.byteLength, 0))
                .toBe(changedBytes.byteLength)
              mutated = true
            } finally {
              fs.closeSync(settingsFd)
            }
          }
        }
        return count
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: `settings-race-${label}-boot-3`,
      durableFs,
    }))
    if (renameFailure) {
      expect(['EACCES', 'EBUSY', 'EPERM']).toContain(renameFailure.code)
      expect(mutated).toBe(false)
    } else {
      expect(mutated).toBe(true)
      expect(error.message).toMatch(/settings|changed|identity|path/i)
    }
    expect(fs.readFileSync(intentPath)).toEqual(completed.staleIntent)
    expect(fs.existsSync(stagingPath)).toBe(true)
    for (const [name, bytes] of stagedBefore) {
      expect(fs.readFileSync(path.join(stagingPath, name))).toEqual(bytes)
    }
    expect(fs.readFileSync(settingsPath)).toEqual(
      replacePath && fs.existsSync(temporary) ? beforeSettings : changedBytes,
    )
    expect(fs.readFileSync(journalPath)).toEqual(beforeJournal)
  })

  it.each([
    ['same-inode same-size rewrite', false],
    ['same-path atomic replacement', true],
  ])('rejects an already-scanned live journal %s', (label, replacePath) => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, replacePath ? 207 : 206, `journal-race-${label}`)
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const settingsPath = path.join(tmpDir, 'settings.json')
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const journalIdentity = fs.statSync(journalPath)
    const beforeSettings = fs.readFileSync(settingsPath)
    const beforeJournal = fs.readFileSync(journalPath)
    const changedJournal = Buffer.from(beforeJournal)
    changedJournal[0] = changedJournal[0] === 0x7b ? 0x5b : 0x7b
    const replacement = path.join(tmpDir, '.journal-race-replacement')
    fs.writeFileSync(replacement, replacePath ? beforeJournal : changedJournal)
    const stagedBefore = ['settings.json', BABY_INFO_JOURNAL_FILE, 'restore-transaction.json']
      .map(name => [name, fs.readFileSync(path.join(stagingPath, name))] as const)

    let mutated = false
    let renameFailure: NodeJS.ErrnoException | undefined
    const durableFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        const count = fs.readSync(fd, buffer, offset, length, position)
        const opened = fs.fstatSync(fd)
        if (!mutated
          && opened.dev === journalIdentity.dev
          && opened.ino === journalIdentity.ino
          && position !== null
          && position + count === opened.size) {
          if (replacePath) {
            try {
              fs.renameSync(replacement, journalPath)
              mutated = true
            } catch (error) {
              renameFailure = error as NodeJS.ErrnoException
              throw error
            }
          } else {
            const journalFd = fs.openSync(journalPath, 'r+')
            try {
              expect(fs.writeSync(journalFd, changedJournal, 0, changedJournal.byteLength, 0))
                .toBe(changedJournal.byteLength)
              mutated = true
            } finally {
              fs.closeSync(journalFd)
            }
          }
        }
        return count
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: `journal-race-${label}-boot-3`,
      durableFs,
    }))
    if (renameFailure) {
      expect(['EACCES', 'EBUSY', 'EPERM']).toContain(renameFailure.code)
      expect(mutated).toBe(false)
    } else {
      expect(mutated).toBe(true)
      expect(error.message).toMatch(/journal|changed|identity|path/i)
    }
    expect(fs.readFileSync(intentPath)).toEqual(completed.staleIntent)
    expect(fs.existsSync(stagingPath)).toBe(true)
    for (const [name, bytes] of stagedBefore) {
      expect(fs.readFileSync(path.join(stagingPath, name))).toEqual(bytes)
    }
    expect(fs.readFileSync(settingsPath)).toEqual(beforeSettings)
    expect(fs.readFileSync(journalPath)).toEqual(replacePath ? beforeJournal : changedJournal)
  })

  it.each([
    ['same-inode rewrite', false],
    ['atomic path swap', true],
  ])('rejects a live journal %s during the final held-settings reread', (label, replacePath) => {
    const completed = reachPrimaryVerifiedWindowsRestore(
      tmpDir,
      replacePath ? 223 : 222,
      `live-held-${replacePath ? 'swap' : 'rewrite'}`,
    )
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const settingsPath = path.join(tmpDir, 'settings.json')
    const settingsIdentity = fs.statSync(settingsPath)
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const settingsBefore = fs.readFileSync(settingsPath)
    const journalBefore = fs.readFileSync(journalPath)
    const journalAfter = Buffer.from(journalBefore)
    journalAfter[0] = journalAfter[0] === 0x7b ? 0x5b : 0x7b
    const replacement = path.join(tmpDir, '.live-held-journal-replacement')
    if (replacePath) fs.writeFileSync(replacement, journalBefore)
    const stagedBefore = ['settings.json', BABY_INFO_JOURNAL_FILE, 'restore-transaction.json']
      .map(name => [name, fs.readFileSync(path.join(stagingPath, name))] as const)

    let settingsPasses = 0
    let mutated = false
    let renameFailure: NodeJS.ErrnoException | undefined
    const durableFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        const count = fs.readSync(fd, buffer, offset, length, position)
        const opened = fs.fstatSync(fd)
        if (opened.dev === settingsIdentity.dev
          && opened.ino === settingsIdentity.ino
          && position !== null
          && position + count === opened.size) {
          settingsPasses += 1
          if (!mutated && settingsPasses === 2) {
            if (replacePath) {
              try {
                fs.renameSync(replacement, journalPath)
                mutated = true
              } catch (error) {
                renameFailure = error as NodeJS.ErrnoException
                throw error
              }
            } else {
              const journalFd = fs.openSync(journalPath, 'r+')
              try {
                expect(fs.writeSync(journalFd, journalAfter, 0, journalAfter.byteLength, 0))
                  .toBe(journalAfter.byteLength)
                mutated = true
              } finally {
                fs.closeSync(journalFd)
              }
            }
          }
        }
        return count
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: `live-held-${label.replaceAll(' ', '-')}-boot-3`,
      durableFs,
    }))
    if (renameFailure) {
      expect(['EACCES', 'EBUSY', 'EPERM']).toContain(renameFailure.code)
      expect(mutated).toBe(false)
    } else {
      expect(mutated).toBe(true)
      expect(error.message).toMatch(/journal|changed|identity|path/i)
    }
    expect(fs.readFileSync(intentPath)).toEqual(completed.staleIntent)
    expect(fs.existsSync(stagingPath)).toBe(true)
    for (const [name, bytes] of stagedBefore) {
      expect(fs.readFileSync(path.join(stagingPath, name))).toEqual(bytes)
    }
    expect(fs.readFileSync(settingsPath)).toEqual(settingsBefore)
    expect(fs.readFileSync(journalPath)).toEqual(replacePath ? journalBefore : journalAfter)
  })

  it.each([
    ['same-inode same-size rewrite', false],
    ['same-path atomic replacement', true],
  ])('rejects an already-scanned backup auxiliary file %s', (label, replacePath) => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, replacePath ? 209 : 208, `aux-race-${label}`)
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))
    const liveJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))
    const dataPath = path.join(tmpDir, 'backups', '2026-07-13_10-20-30', 'data', '2026-07.jsonl')
    const dataIdentity = fs.statSync(dataPath)
    const beforeData = fs.readFileSync(dataPath)
    const changedData = Buffer.from('{"event":null}\n', 'utf8')
    expect(changedData.byteLength).toBe(beforeData.byteLength)
    const replacement = path.join(tmpDir, '.aux-race-replacement')
    fs.writeFileSync(replacement, replacePath ? beforeData : changedData)

    let mutated = false
    let renameFailure: NodeJS.ErrnoException | undefined
    const durableFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        const count = fs.readSync(fd, buffer, offset, length, position)
        const opened = fs.fstatSync(fd)
        if (!mutated
          && opened.dev === dataIdentity.dev
          && opened.ino === dataIdentity.ino
          && position !== null
          && position + count === opened.size) {
          if (replacePath) {
            try {
              fs.renameSync(replacement, dataPath)
              mutated = true
            } catch (error) {
              renameFailure = error as NodeJS.ErrnoException
              throw error
            }
          } else {
            const dataFd = fs.openSync(dataPath, 'r+')
            try {
              expect(fs.writeSync(dataFd, changedData, 0, changedData.byteLength, 0))
                .toBe(changedData.byteLength)
              mutated = true
            } finally {
              fs.closeSync(dataFd)
            }
          }
        }
        return count
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: `aux-race-${label}-boot-3`,
      durableFs,
    }))
    if (renameFailure) {
      expect(['EACCES', 'EBUSY', 'EPERM']).toContain(renameFailure.code)
      expect(mutated).toBe(false)
    } else {
      expect(mutated).toBe(true)
      expect(error.message).toMatch(/backup|changed|checksum|identity|path/i)
    }
    expect(fs.readFileSync(intentPath)).toEqual(completed.staleIntent)
    expect(fs.existsSync(stagingPath)).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(liveJournal)
    expect(fs.readFileSync(dataPath)).toEqual(replacePath ? beforeData : changedData)
  })

  it.each([
    ['journal same-inode rewrite', BABY_INFO_JOURNAL_FILE, false],
    ['journal atomic path swap', BABY_INFO_JOURNAL_FILE, true],
    ['earlier auxiliary same-inode rewrite', 'data/2026-07.jsonl', false],
    ['earlier auxiliary atomic path swap', 'data/2026-07.jsonl', true],
  ])('rejects an already-closed backup %s while a later auxiliary file is scanned', (
    _label,
    relativeTarget,
    replacePath,
  ) => {
    const completed = reachPrimaryVerifiedWindowsRestore(
      tmpDir,
      relativeTarget === BABY_INFO_JOURNAL_FILE
        ? (replacePath ? 218 : 216)
        : (replacePath ? 219 : 217),
      `closed-proof-${relativeTarget === BABY_INFO_JOURNAL_FILE ? 'journal' : 'data'}-${replacePath ? 'swap' : 'rewrite'}`,
    )
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const snapshot = path.join(tmpDir, 'backups', '2026-07-13_10-20-30')
    const laterDataPath = path.join(snapshot, 'data', '2026-08.jsonl')
    fs.writeFileSync(laterDataPath, '{"later":true}\n')
    writeManifest(snapshot)
    const laterIdentity = fs.statSync(laterDataPath)
    const targetPath = path.join(snapshot, ...relativeTarget.split('/'))
    const targetBefore = fs.readFileSync(targetPath)
    const targetAfter = Buffer.from(targetBefore)
    targetAfter[0] = targetAfter[0] === 0x7b ? 0x5b : 0x7b
    const replacementPath = path.join(
      tmpDir,
      `.closed-proof-${relativeTarget === BABY_INFO_JOURNAL_FILE ? 'journal' : 'data'}-replacement`,
    )
    if (replacePath) fs.writeFileSync(replacementPath, targetBefore)
    const liveSettings = fs.readFileSync(path.join(tmpDir, 'settings.json'))
    const liveJournal = fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))
    const stagedBefore = ['settings.json', BABY_INFO_JOURNAL_FILE, 'restore-transaction.json']
      .map(name => [name, fs.readFileSync(path.join(stagingPath, name))] as const)

    let rewritten = false
    let renameFailure: NodeJS.ErrnoException | undefined
    const durableFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        const count = fs.readSync(fd, buffer, offset, length, position)
        const opened = fs.fstatSync(fd)
        if (!rewritten && opened.dev === laterIdentity.dev && opened.ino === laterIdentity.ino) {
          if (replacePath) {
            try {
              fs.renameSync(replacementPath, targetPath)
              rewritten = true
            } catch (error) {
              renameFailure = error as NodeJS.ErrnoException
              throw error
            }
          } else {
            const targetFd = fs.openSync(targetPath, 'r+')
            try {
              expect(fs.writeSync(targetFd, targetAfter, 0, targetAfter.byteLength, 0))
                .toBe(targetAfter.byteLength)
              rewritten = true
            } finally {
              fs.closeSync(targetFd)
            }
          }
        }
        return count
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: `closed-proof-${relativeTarget === BABY_INFO_JOURNAL_FILE ? 'journal' : 'data'}-${replacePath ? 'swap' : 'rewrite'}-boot-3`,
      durableFs,
    }))
    if (renameFailure) {
      expect(['EACCES', 'EBUSY', 'EPERM']).toContain(renameFailure.code)
      expect(rewritten).toBe(false)
    } else {
      expect(rewritten).toBe(true)
      expect(error.message).toMatch(/backup|changed|identity|path/i)
    }
    expect(fs.readFileSync(intentPath)).toEqual(completed.staleIntent)
    expect(fs.existsSync(stagingPath)).toBe(true)
    for (const [name, bytes] of stagedBefore) {
      expect(fs.readFileSync(path.join(stagingPath, name))).toEqual(bytes)
    }
    expect(fs.readFileSync(targetPath)).toEqual(replacePath ? targetBefore : targetAfter)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(liveSettings)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(liveJournal)
  })

  it.each([
    ['backup manifest same-inode rewrite', 'backup', false],
    ['backup manifest atomic path swap', 'backup', true],
    ['forensic manifest same-inode rewrite', 'forensic', false],
    ['forensic manifest atomic path swap', 'forensic', true],
  ])('keeps the %s held until the final Windows cleanup decision', (
    _label,
    targetKind,
    replacePath,
  ) => {
    const completed = reachPrimaryVerifiedWindowsRestore(
      tmpDir,
      targetKind === 'backup'
        ? (replacePath ? 225 : 224)
        : (replacePath ? 227 : 226),
      `held-manifest-${targetKind}-${replacePath ? 'swap' : 'rewrite'}`,
    )
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const targetPath = targetKind === 'backup'
      ? path.join(tmpDir, 'backups', '2026-07-13_10-20-30', MANIFEST_FILE)
      : path.join(completed.forensicArchive, MANIFEST_FILE)
    const triggerPath = targetKind === 'backup'
      ? path.join(completed.forensicArchive, 'settings.json')
      : path.join(tmpDir, 'settings.json')
    const triggerIdentity = fs.statSync(triggerPath)
    const targetBefore = fs.readFileSync(targetPath)
    const targetAfter = Buffer.from(targetBefore)
    targetAfter[0] = targetAfter[0] === 0x7b ? 0x5b : 0x7b
    const replacement = path.join(
      tmpDir,
      `.held-${targetKind}-manifest-replacement-${replacePath ? 'swap' : 'rewrite'}`,
    )
    if (replacePath) fs.writeFileSync(replacement, targetBefore)
    const liveBefore = ['settings.json', BABY_INFO_JOURNAL_FILE]
      .map(name => [name, fs.readFileSync(path.join(tmpDir, name))] as const)
    const stagedBefore = ['settings.json', BABY_INFO_JOURNAL_FILE, 'restore-transaction.json']
      .map(name => [name, fs.readFileSync(path.join(stagingPath, name))] as const)

    let mutated = false
    let renameFailure: NodeJS.ErrnoException | undefined
    const durableFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        const count = fs.readSync(fd, buffer, offset, length, position)
        const opened = fs.fstatSync(fd)
        if (!mutated
          && !renameFailure
          && opened.dev === triggerIdentity.dev
          && opened.ino === triggerIdentity.ino
          && position !== null
          && position + count === opened.size) {
          if (replacePath) {
            try {
              fs.renameSync(replacement, targetPath)
              mutated = true
            } catch (error) {
              renameFailure = error as NodeJS.ErrnoException
              throw error
            }
          } else {
            const targetFd = fs.openSync(targetPath, 'r+')
            try {
              expect(fs.writeSync(targetFd, targetAfter, 0, targetAfter.byteLength, 0))
                .toBe(targetAfter.byteLength)
              mutated = true
            } finally {
              fs.closeSync(targetFd)
            }
          }
        }
        return count
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: `held-manifest-${targetKind}-${replacePath ? 'swap' : 'rewrite'}-boot-3`,
      durableFs,
    }))
    if (renameFailure) {
      expect(['EACCES', 'EBUSY', 'EPERM']).toContain(renameFailure.code)
      expect(mutated).toBe(false)
      expect(fs.readFileSync(targetPath)).toEqual(targetBefore)
    } else {
      expect(mutated).toBe(true)
      expect(error.message).toMatch(/manifest|backup|forensic|changed|identity|path/i)
      expect(fs.readFileSync(targetPath)).toEqual(replacePath ? targetBefore : targetAfter)
    }
    expect(fs.readFileSync(intentPath)).toEqual(completed.staleIntent)
    expect(fs.existsSync(stagingPath)).toBe(true)
    for (const [name, bytes] of stagedBefore) {
      expect(fs.readFileSync(path.join(stagingPath, name))).toEqual(bytes)
    }
    for (const [name, bytes] of liveBefore) {
      expect(fs.readFileSync(path.join(tmpDir, name))).toEqual(bytes)
    }
  })

  it('revalidates a held manifest between cleanup steps after two data files and a short-read 128 MiB scan', () => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 232, 'held-manifest-maximum')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const transaction = JSON.parse(completed.staleIntent.toString('utf8'))
    transaction.lastWindowsStartupId = ''
    const expectedIntent = Buffer.from(JSON.stringify(transaction, null, 2), 'utf8')
    fs.writeFileSync(intentPath, expectedIntent)
    fs.writeFileSync(path.join(stagingPath, 'restore-transaction.json'), expectedIntent)
    const snapshot = path.join(tmpDir, 'backups', '2026-07-13_10-20-30')
    const largeDataPath = path.join(snapshot, 'data', '2026-07.jsonl')
    const secondDataPath = path.join(snapshot, 'data', '2026-08.jsonl')
    fs.writeFileSync(secondDataPath, '{"second":true}\n')
    writeManifest(snapshot)
    const prefix = fs.readFileSync(path.join(snapshot, BABY_INFO_JOURNAL_FILE))
    const fixture = syntheticMaximumJournal(prefix)
    fs.truncateSync(largeDataPath, fixture.size)
    const manifestPath = path.join(snapshot, MANIFEST_FILE)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const largeEntry = manifest.files.find((entry: { path: string }) => entry.path === 'data/2026-07.jsonl')
    largeEntry.size = fixture.size
    largeEntry.sha256 = fixture.sha256
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    const manifestBefore = fs.readFileSync(manifestPath)
    const manifestAfter = Buffer.from(manifestBefore)
    manifestAfter[0] = manifestAfter[0] === 0x7b ? 0x5b : 0x7b
    const largeIdentity = fs.statSync(largeDataPath)
    const reads: Array<{ position: number; requested: number; returned: number }> = []
    const stagedBefore = ['settings.json', BABY_INFO_JOURNAL_FILE, 'restore-transaction.json']
      .map(name => [name, fs.readFileSync(path.join(stagingPath, name))] as const)
    let mutated = false
    let largeDataEofs = 0
    const posixOps = simulatedPosixOps()
    const durableFs: InstrumentedDurableFileOps = {
      ...posixOps,
      openSync(target, flags, mode) {
        if (!mutated
          && path.resolve(String(target)) === path.resolve(tmpDir)
          && !fs.existsSync(stagingPath)
          && fs.existsSync(intentPath)) {
          const manifestFd = fs.openSync(manifestPath, 'r+')
          try {
            expect(fs.writeSync(manifestFd, manifestAfter, 0, manifestAfter.byteLength, 0))
              .toBe(manifestAfter.byteLength)
            mutated = true
          } finally {
            fs.closeSync(manifestFd)
          }
        }
        return posixOps.openSync(target, flags, mode)
      },
      readSync(fd, buffer, offset, length, position) {
        if (position === null) throw new Error('cleanup evidence reads must be positional')
        const opened = fs.fstatSync(fd)
        if (opened.dev === largeIdentity.dev && opened.ino === largeIdentity.ino) {
          const returned = Math.min(length, 32 * 1024)
          const target = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          fixture.readInto(target, offset, returned, position)
          reads.push({ position, requested: length, returned })
          if (position + returned === fixture.size) {
            largeDataEofs += 1
          }
          return returned
        }
        return fs.readSync(fd, buffer, offset, length, position)
      },
    }

    let error: Error & Record<string, unknown> | undefined
    const startedAt = Date.now()
    let allocations: Array<{ method: string; size: number }> = []
    allocations = guardBufferAllocations(64 * 1024, () => {
      try {
        recoverSettingsAndJournalPair(tmpDir, {
          platform: 'linux',
          durableFs,
        })
      } catch (caught) {
        if (!(caught instanceof Error)) throw caught
        error = caught as Error & Record<string, unknown>
      }
    })
    const elapsedMs = Date.now() - startedAt

    expect(error).toBeDefined()
    expect(error!.message).toMatch(/manifest|backup|changed|identity|path/i)
    expect(fs.readFileSync(manifestPath)).toEqual(manifestAfter)
    expect(Math.max(...allocations.map(allocation => allocation.size))).toBeLessThanOrEqual(64 * 1024)
    expect(reads.some(read => read.returned < read.requested)).toBe(true)
    expect(Math.max(...reads.map(read => read.requested))).toBeLessThanOrEqual(64 * 1024)
    expect(reads.reduce((total, read) => total + read.returned, 0)).toBe(fixture.size * 3)
    expect(reads.filter(read => read.position + read.returned === fixture.size)).toHaveLength(3)
    expect(elapsedMs).toBeLessThan(20_000)
    expect(fs.readFileSync(intentPath)).toEqual(expectedIntent)
    expect(fs.existsSync(stagingPath)).toBe(false)
    expect(stagedBefore).toHaveLength(3)
  })

  it('rejects a backup file added after its bounded pre-scan inventory', () => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 210, 'backup-set-add')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const snapshot = path.join(tmpDir, 'backups', '2026-07-13_10-20-30')
    const journalPath = path.join(snapshot, BABY_INFO_JOURNAL_FILE)
    const journalIdentity = fs.statSync(journalPath)
    const extraPath = path.join(snapshot, 'data', 'scan-extra.jsonl')
    let added = false
    const durableFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        const count = fs.readSync(fd, buffer, offset, length, position)
        const opened = fs.fstatSync(fd)
        if (!added && opened.dev === journalIdentity.dev && opened.ino === journalIdentity.ino) {
          added = true
          fs.writeFileSync(extraPath, '{}\n')
        }
        return count
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'backup-set-add-boot-3',
      durableFs,
    }))
    expect(added).toBe(true)
    expect(error.message).toMatch(/manifest|complete|identity|backup/i)
    expect(fs.readFileSync(intentPath)).toEqual(completed.staleIntent)
    expect(fs.existsSync(stagingPath)).toBe(true)
    expect(fs.existsSync(extraPath)).toBe(true)
  })

  it('rejects a same-content backup data-directory replacement during verification', () => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 211, 'backup-set-swap')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const snapshot = path.join(tmpDir, 'backups', '2026-07-13_10-20-30')
    const journalPath = path.join(snapshot, BABY_INFO_JOURNAL_FILE)
    const journalIdentity = fs.statSync(journalPath)
    const dataDir = path.join(snapshot, 'data')
    const displacedDataDir = path.join(tmpDir, '.displaced-backup-data')
    let swapped = false
    let renameFailure: NodeJS.ErrnoException | undefined
    const durableFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        const count = fs.readSync(fd, buffer, offset, length, position)
        const opened = fs.fstatSync(fd)
        if (!swapped && opened.dev === journalIdentity.dev && opened.ino === journalIdentity.ino) {
          try {
            fs.renameSync(dataDir, displacedDataDir)
            fs.mkdirSync(dataDir)
            fs.copyFileSync(
              path.join(displacedDataDir, '2026-07.jsonl'),
              path.join(dataDir, '2026-07.jsonl'),
            )
            swapped = true
          } catch (error) {
            renameFailure = error as NodeJS.ErrnoException
            throw error
          }
        }
        return count
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'backup-set-swap-boot-3',
      durableFs,
    }))
    if (renameFailure) {
      expect(['EACCES', 'EBUSY', 'EPERM']).toContain(renameFailure.code)
      expect(swapped).toBe(false)
    } else {
      expect(swapped).toBe(true)
      expect(error.message).toMatch(/directory|identity|backup|changed/i)
    }
    expect(fs.readFileSync(intentPath)).toEqual(completed.staleIntent)
    expect(fs.existsSync(stagingPath)).toBe(true)
  })

  it('rejects a forensic extra entry before scanning any evidence file', () => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 212, 'forensic-set-pre')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const forensicJournalPath = path.join(completed.forensicArchive, BABY_INFO_JOURNAL_FILE)
    const forensicJournalIdentity = fs.statSync(forensicJournalPath)
    const extraPath = path.join(completed.forensicArchive, 'scan-extra')
    fs.writeFileSync(extraPath, 'remove during scan')
    const realFstat = fs.fstatSync.bind(fs)
    let removed = false
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number): fs.Stats => {
      const opened = realFstat(fd)
      if (!removed && opened.dev === forensicJournalIdentity.dev && opened.ino === forensicJournalIdentity.ino) {
        removed = true
        fs.unlinkSync(extraPath)
      }
      return opened
    }) as typeof fs.fstatSync)

    let error: Error & Record<string, unknown>
    try {
      error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
        platform: 'win32',
        startupId: 'forensic-set-pre-boot-3',
      }))
    } finally {
      fstatSpy.mockRestore()
    }
    expect(error!.message).toMatch(/forensic|unexpected|entry/i)
    expect(removed).toBe(false)
    expect(fs.existsSync(extraPath)).toBe(true)
    expect(fs.readFileSync(intentPath)).toEqual(completed.staleIntent)
    expect(fs.existsSync(stagingPath)).toBe(true)
  })

  it.each([
    ['same-inode rewrite', false],
    ['atomic path swap', true],
  ])('rejects a forensic journal %s during the final held-settings reread', (label, replacePath) => {
    const completed = reachPrimaryVerifiedWindowsRestore(
      tmpDir,
      replacePath ? 221 : 220,
      `forensic-held-${replacePath ? 'swap' : 'rewrite'}`,
    )
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const forensicSettingsPath = path.join(completed.forensicArchive, 'settings.json')
    const forensicSettingsIdentity = fs.statSync(forensicSettingsPath)
    const forensicJournalPath = path.join(completed.forensicArchive, BABY_INFO_JOURNAL_FILE)
    const journalBefore = fs.readFileSync(forensicJournalPath)
    const journalAfter = Buffer.from(journalBefore)
    journalAfter[0] = journalAfter[0] === 0x7b ? 0x5b : 0x7b
    const replacement = path.join(tmpDir, '.forensic-held-journal-replacement')
    if (replacePath) fs.writeFileSync(replacement, journalBefore)
    const stagedBefore = ['settings.json', BABY_INFO_JOURNAL_FILE, 'restore-transaction.json']
      .map(name => [name, fs.readFileSync(path.join(stagingPath, name))] as const)

    let settingsPasses = 0
    let mutated = false
    let renameFailure: NodeJS.ErrnoException | undefined
    const durableFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        const count = fs.readSync(fd, buffer, offset, length, position)
        const opened = fs.fstatSync(fd)
        if (opened.dev === forensicSettingsIdentity.dev
          && opened.ino === forensicSettingsIdentity.ino
          && position !== null
          && position + count === opened.size) {
          settingsPasses += 1
          if (!mutated && settingsPasses === 2) {
            if (replacePath) {
              try {
                fs.renameSync(replacement, forensicJournalPath)
                mutated = true
              } catch (error) {
                renameFailure = error as NodeJS.ErrnoException
                throw error
              }
            } else {
              const journalFd = fs.openSync(forensicJournalPath, 'r+')
              try {
                expect(fs.writeSync(journalFd, journalAfter, 0, journalAfter.byteLength, 0))
                  .toBe(journalAfter.byteLength)
                mutated = true
              } finally {
                fs.closeSync(journalFd)
              }
            }
          }
        }
        return count
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: `forensic-held-${label.replaceAll(' ', '-')}-boot-3`,
      durableFs,
    }))
    if (renameFailure) {
      expect(['EACCES', 'EBUSY', 'EPERM']).toContain(renameFailure.code)
      expect(mutated).toBe(false)
    } else {
      expect(mutated).toBe(true)
      expect(error.message).toMatch(/forensic|journal|changed|identity|path/i)
    }
    expect(fs.readFileSync(intentPath)).toEqual(completed.staleIntent)
    expect(fs.existsSync(stagingPath)).toBe(true)
    for (const [name, bytes] of stagedBefore) {
      expect(fs.readFileSync(path.join(stagingPath, name))).toEqual(bytes)
    }
    expect(fs.readFileSync(forensicJournalPath)).toEqual(replacePath ? journalBefore : journalAfter)
  })

  it.each([
    ['matching descriptor', true],
    ['mismatched descriptor', false],
  ])('streams a logical 128 MiB forensic journal with a %s using bounded allocations', (
    _label,
    descriptorMatches,
  ) => {
    const advanced = cleanRestoreAndAdvanceSettings(
      tmpDir,
      descriptorMatches ? 213 : 214,
      descriptorMatches ? 'forensic-max-ok' : 'forensic-max-bad',
    )
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const snapshotJournalPath = path.join(
      tmpDir,
      'backups',
      '2026-07-13_10-20-30',
      BABY_INFO_JOURNAL_FILE,
    )
    const fixture = syntheticMaximumJournal(fs.readFileSync(snapshotJournalPath))
    const forensicJournalPath = path.join(advanced.forensicArchive, BABY_INFO_JOURNAL_FILE)
    fs.truncateSync(forensicJournalPath, fixture.size)

    const manifestPath = path.join(advanced.forensicArchive, MANIFEST_FILE)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const journalEntry = manifest.files.find((entry: { path: string }) => (
      entry.path === BABY_INFO_JOURNAL_FILE
    ))
    journalEntry.size = fixture.size
    journalEntry.sha256 = descriptorMatches ? fixture.sha256 : '0'.repeat(64)
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
    fs.writeFileSync(manifestPath, manifestBytes)

    const transaction = JSON.parse(advanced.staleIntent.toString('utf8'))
    transaction.forensicManifest = {
      size: manifestBytes.byteLength,
      sha256: digest(manifestBytes),
    }
    fs.writeFileSync(intentPath, JSON.stringify(transaction, null, 2), 'utf8')

    const realRead = fs.readSync.bind(fs)
    const forensicFds = new Set<number>()
    const readRequests: Array<{ position: number; length: number }> = []
    const streamedRead = (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      if (!forensicFds.has(fd)) {
        return realRead(fd, buffer, offset, length, position)
      }
      if (position === null) throw new Error('forensic journal reads must be positional')
      readRequests.push({ position, length })
      const target = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      return fixture.readInto(target, offset, length, position)
    }
    const streamingFs: InstrumentedDurableFileOps = {
      ...fs,
      openSync(target, flags, mode) {
        const fd = fs.openSync(target, flags, mode)
        if (path.resolve(String(target)) === path.resolve(forensicJournalPath)) {
          forensicFds.add(fd)
        }
        return fd
      },
      readSync: streamedRead,
      closeSync(fd) {
        forensicFds.delete(fd)
        fs.closeSync(fd)
      },
    }
    let caught: Error & Record<string, unknown> | undefined
    let allocations: Array<{ method: string; size: number }> = []
    const startedAt = Date.now()
    allocations = guardBufferAllocations(64 * 1024, () => {
      try {
        recoverSettingsAndJournalPair(tmpDir, {
          platform: 'win32',
          startupId: descriptorMatches ? 'forensic-max-ok-boot-4' : 'forensic-max-bad-boot-4',
          durableFs: streamingFs,
        })
      } catch (error) {
        caught = error as Error & Record<string, unknown>
      }
    })
    const elapsedMs = Date.now() - startedAt

    expect(Math.max(...allocations.map(allocation => allocation.size))).toBeLessThanOrEqual(64 * 1024)
    expect(Math.max(...readRequests.map(request => request.length))).toBeLessThanOrEqual(64 * 1024)
    const expectedPasses = descriptorMatches ? 3 : 2
    expect(readRequests.reduce((total, request) => total + request.length, 0))
      .toBe(fixture.size * expectedPasses)
    expect(readRequests.filter(request => request.position + request.length === fixture.size))
      .toHaveLength(expectedPasses)
    expect(elapsedMs).toBeLessThan(10_000)
    if (descriptorMatches) {
      expect(caught).toBeUndefined()
      expect(fs.existsSync(intentPath)).toBe(false)
    } else {
      expect(caught?.message).toMatch(/forensic|checksum/i)
      expect(fs.existsSync(intentPath)).toBe(true)
      expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(advanced.liveSettings)
      expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(advanced.liveJournal)
    }
  })

  it('handles real-disk short reads through every cleanup revalidation and closes every source handle', () => {
    const completed = reachPrimaryVerifiedWindowsRestore(tmpDir, 215, 'short-read')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const snapshotPath = path.join(tmpDir, 'backups', '2026-07-13_10-20-30')
    const snapshotJournalPath = path.join(snapshotPath, BABY_INFO_JOURNAL_FILE)
    const liveJournalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const stagingJournalPath = path.join(stagingPath, BABY_INFO_JOURNAL_FILE)
    const prefix = fs.readFileSync(snapshotJournalPath)
    const importJson = Buffer.from('{"version":1,"type":"import","sourceId":"short-read"}', 'utf8')
    const line = Buffer.concat([
      importJson,
      Buffer.alloc((4 * 1024) - importJson.byteLength - 1, 0x20),
      Buffer.from('\n'),
    ], 4 * 1024)
    const journalBytes = Buffer.concat([prefix, ...Array.from({ length: 64 }, () => line)])
    for (const target of [snapshotJournalPath, liveJournalPath, stagingJournalPath]) {
      fs.writeFileSync(target, journalBytes)
    }

    const manifestPath = path.join(snapshotPath, MANIFEST_FILE)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const manifestJournal = manifest.files.find((entry: { path: string }) => (
      entry.path === BABY_INFO_JOURNAL_FILE
    ))
    manifestJournal.size = journalBytes.byteLength
    manifestJournal.sha256 = digest(journalBytes)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    const transaction = JSON.parse(completed.staleIntent.toString('utf8'))
    transaction.journal = { size: journalBytes.byteLength, sha256: digest(journalBytes) }
    fs.writeFileSync(intentPath, JSON.stringify(transaction, null, 2), 'utf8')
    fs.writeFileSync(
      path.join(stagingPath, 'restore-transaction.json'),
      JSON.stringify(transaction, null, 2),
      'utf8',
    )

    const targetIdentities = new Map([snapshotJournalPath, liveJournalPath, stagingJournalPath].map(target => {
      const stat = fs.statSync(target)
      const source = target === snapshotJournalPath
        ? 'backup'
        : target === stagingJournalPath ? 'staging' : 'live'
      return [`${stat.dev}:${stat.ino}`, source]
    }))
    const reads: Array<{ source: string; position: number; requested: number; count: number }> = []
    const shortReadFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        const opened = fs.fstatSync(fd)
        const source = targetIdentities.get(`${opened.dev}:${opened.ino}`)
        const isTarget = opened.size === journalBytes.byteLength && source !== undefined
        const requested = isTarget ? Math.min(length, 4 * 1024) : length
        const count = fs.readSync(fd, buffer, offset, requested, position)
        if (isTarget) {
          if (position === null) throw new Error('short-read verification must be positional')
          reads.push({ source, position, requested, count })
        }
        return count
      },
    }

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'short-read-boot-3',
      durableFs: shortReadFs,
    })).not.toThrow()
    expect(Math.max(...reads.map(read => read.requested))).toBeLessThanOrEqual(4 * 1024)
    expect(reads.reduce((total, read) => total + read.count, 0)).toBe(journalBytes.byteLength * 11)
    expect(reads.filter(read => read.position + read.count === journalBytes.byteLength)).toHaveLength(11)
    expect(Object.fromEntries(['backup', 'staging', 'live'].map(source => [
      source,
      reads.filter(read => (
        read.source === source
        && read.position + read.count === journalBytes.byteLength
      )).length,
    ]))).toEqual({ backup: 5, staging: 2, live: 4 })
    expect(fs.existsSync(intentPath)).toBe(false)
    expect(fs.existsSync(stagingPath)).toBe(false)

    const reopened = fs.openSync(liveJournalPath, 'r')
    fs.closeSync(reopened)
    const moved = `${liveJournalPath}.closed-check`
    fs.renameSync(liveJournalPath, moved)
    fs.renameSync(moved, liveJournalPath)
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
        if (fs.fstatSync(fd).size !== maximumJournalBytes) {
          return fs.readSync(fd, buffer, offset, length, position)
        }
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
    expect(
      Math.max(...readRequests.map(request => request.length)),
      `RSS growth diagnostic only: ${rssGrowth}`,
    ).toBeLessThanOrEqual(64 * 1024)
    expect(readRequests.reduce((total, request) => total + request.length, 0)).toBe(maximumJournalBytes * 3)
    expect(readRequests.at(-1)!.position + readRequests.at(-1)!.length).toBe(maximumJournalBytes)
    expect(readRequests.filter(request => request.position + request.length === maximumJournalBytes))
      .toHaveLength(3)
    expect(elapsedMs).toBeLessThan(10_000)
    expect(fs.existsSync(intentPath)).toBe(false)

    fs.writeFileSync(intentPath, completed.staleIntent)
    const invalidReadRequests: Array<{ position: number; length: number }> = []
    const actualStreamingFs: InstrumentedDurableFileOps = {
      ...fs,
      readSync(fd, buffer, offset, length, position) {
        if (position === null) throw new Error('live advancement reads must be positional')
        if (fs.fstatSync(fd).size !== maximumJournalBytes) {
          return fs.readSync(fd, buffer, offset, length, position)
        }
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

  it.each([
    ['same-inode rewrite', false],
    ['atomic path swap', true],
  ])('keeps POSIX primary-verified evidence when the live journal suffers a cleanup-window %s', (
    _label,
    replacePath,
  ) => {
    const snapshot = writeSnapshot(
      tmpDir,
      '2026-07-13_10-20-30',
      [mutation(replacePath ? 230 : 229)],
    )
    writeCorruptLivePair(tmpDir)
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const expectedRestoredSettings = fs.readFileSync(path.join(snapshot.snapshot, 'settings.json'))
    const expectedRestoredJournal = Buffer.from(snapshot.journal)
    const changedJournal = Buffer.from(expectedRestoredJournal)
    changedJournal[0] = changedJournal[0] === 0x7b ? 0x5b : 0x7b
    const replacement = path.join(tmpDir, '.posix-cleanup-journal-replacement')
    if (replacePath) fs.writeFileSync(replacement, expectedRestoredJournal)

    const posixOps = simulatedPosixOps()
    let mutated = false
    let renameFailure: NodeJS.ErrnoException | undefined
    const durableFs: DurableFileOps = {
      ...posixOps,
      renameSync(oldPath, newPath) {
        const destination = path.resolve(String(newPath))
        const isIntent = destination === path.resolve(intentPath)
        let phase: string | undefined
        if (isIntent) {
          try { phase = JSON.parse(fs.readFileSync(oldPath, 'utf8')).phase } catch { /* not transaction bytes */ }
        }
        posixOps.renameSync(oldPath, newPath)
        if (!mutated && !renameFailure && phase === 'primary-verified') {
          if (replacePath) {
            try {
              fs.renameSync(replacement, journalPath)
              mutated = true
            } catch (error) {
              renameFailure = error as NodeJS.ErrnoException
              throw error
            }
          } else {
            const journalFd = fs.openSync(journalPath, 'r+')
            try {
              expect(fs.writeSync(journalFd, changedJournal, 0, changedJournal.byteLength, 0))
                .toBe(changedJournal.byteLength)
              mutated = true
            } finally {
              fs.closeSync(journalFd)
            }
          }
        }
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'linux',
      durableFs,
    }))
    if (renameFailure) {
      expect(['EACCES', 'EBUSY', 'EPERM']).toContain(renameFailure.code)
      expect(mutated).toBe(false)
      expect(fs.readFileSync(journalPath)).toEqual(expectedRestoredJournal)
    } else {
      expect(mutated).toBe(true)
      expect(error.message).toMatch(/live|journal|changed|identity|path|verification/i)
      expect(fs.readFileSync(journalPath)).toEqual(
        replacePath ? expectedRestoredJournal : changedJournal,
      )
    }
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(expectedRestoredSettings)
    expect(JSON.parse(fs.readFileSync(intentPath, 'utf8')).phase).toBe('primary-verified')
    expect(fs.existsSync(stagingPath)).toBe(true)
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

  it('keeps POSIX tombstone deletion last when cleanup reports a crash after unlink', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(149)])
    writeCorruptLivePair(tmpDir)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const posixOps = simulatedPosixOps()
    let failAfterTombstoneDeletion = true
    const durableFs: DurableFileOps = {
      ...posixOps,
      unlinkSync(target) {
        const isIntentTombstone = path.dirname(String(target)) === tmpDir
          && path.basename(String(target)).startsWith(`${RESTORE_INTENT_FILE}.cleanup-`)
        if (isIntentTombstone) {
          expect(fs.existsSync(stagingPath)).toBe(false)
        }
        posixOps.unlinkSync(target)
        if (failAfterTombstoneDeletion && isIntentTombstone) {
          failAfterTombstoneDeletion = false
          throw new Error('simulated POSIX crash after intent tombstone deletion')
        }
      },
    }

    expect(() => new SettingsStore(tmpDir, { platform: 'linux', durableFs }))
      .toThrow(/simulated POSIX crash after intent tombstone deletion/i)
    expect(fs.existsSync(path.join(tmpDir, RESTORE_INTENT_FILE))).toBe(false)
    expect(fs.existsSync(stagingPath)).toBe(false)

    expect(() => new SettingsStore(tmpDir, { platform: 'linux', durableFs })).not.toThrow()
    expect(fs.existsSync(stagingPath)).toBe(false)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(
      fs.readFileSync(path.join(snapshot.snapshot, 'settings.json')),
    )
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(snapshot.journal)
  })

  it('does not delete a canonical intent replaced after staging cleanup', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(238)])
    writeCorruptLivePair(tmpDir)
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    const posixOps = simulatedPosixOps()
    let replacement: Buffer | undefined
    const durableFs: DurableFileOps = {
      ...posixOps,
      openSync(target, flags, mode) {
        if (!replacement
          && path.resolve(String(target)) === path.resolve(tmpDir)
          && !fs.existsSync(stagingPath)
          && fs.existsSync(intentPath)) {
          const value = JSON.parse(fs.readFileSync(intentPath, 'utf8'))
          value.snapshotId = 'newer-recovery-authority'
          replacement = Buffer.from(JSON.stringify(value, null, 2), 'utf8')
          const temporary = `${intentPath}.new-authority`
          fs.writeFileSync(temporary, replacement)
          fs.renameSync(temporary, intentPath)
        }
        return posixOps.openSync(target, flags, mode)
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'linux',
      durableFs,
    }))

    expect(replacement).toBeDefined()
    expect(error.message).toMatch(/intent|transaction|changed|identity|authority/i)
    expect(fs.readFileSync(intentPath)).toEqual(replacement)
  })

  it('deletes only its tombstone when a new canonical intent appears after rename', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(239)])
    writeCorruptLivePair(tmpDir)
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const posixOps = simulatedPosixOps()
    const newer = Buffer.from(JSON.stringify({
      version: 1,
      snapshotId: 'newer-recovery-authority',
      settings: { size: 0, sha256: '0'.repeat(64) },
      journal: { size: 0, sha256: '0'.repeat(64) },
    }, null, 2), 'utf8')
    let tombstoned = false
    let directorySyncedAfterRename = false
    let tombstoneDeletedAfterSync = false
    const durableFs: DurableFileOps = {
      ...posixOps,
      renameSync(source, destination) {
        posixOps.renameSync(source, destination)
        if (!tombstoned
          && path.resolve(String(source)) === path.resolve(intentPath)
          && path.basename(String(destination)).startsWith(`${RESTORE_INTENT_FILE}.cleanup-`)) {
          tombstoned = true
          fs.writeFileSync(intentPath, newer)
        }
      },
      fsyncSync(fd) {
        if (tombstoned) directorySyncedAfterRename = true
        posixOps.fsyncSync(fd)
      },
      unlinkSync(target) {
        if (path.basename(String(target)).startsWith(`${RESTORE_INTENT_FILE}.cleanup-`)) {
          expect(directorySyncedAfterRename).toBe(true)
          tombstoneDeletedAfterSync = true
        }
        posixOps.unlinkSync(target)
      },
    }

    recoverSettingsAndJournalPair(tmpDir, { platform: 'linux', durableFs })

    expect(tombstoned).toBe(true)
    expect(directorySyncedAfterRename).toBe(true)
    expect(tombstoneDeletedAfterSync).toBe(true)
    expect(fs.readFileSync(intentPath)).toEqual(newer)
    expect(fs.readdirSync(tmpDir).filter(name => name.startsWith(`${RESTORE_INTENT_FILE}.cleanup-`)))
      .toEqual([])
  })

  it('uses the same tombstone isolation on Windows cleanup', () => {
    reachPrimaryVerifiedWindowsRestore(tmpDir, 242, 'intent-tombstone-win')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const newer = Buffer.from(JSON.stringify({
      version: 1,
      snapshotId: 'newer-windows-recovery-authority',
      settings: { size: 0, sha256: '2'.repeat(64) },
      journal: { size: 0, sha256: '2'.repeat(64) },
    }, null, 2), 'utf8')
    let tombstoned = false
    const durableFs: DurableFileOps = {
      ...fs,
      renameSync(source, destination) {
        fs.renameSync(source, destination)
        if (!tombstoned
          && path.resolve(String(source)) === path.resolve(intentPath)
          && path.basename(String(destination)).startsWith(`${RESTORE_INTENT_FILE}.cleanup-`)) {
          tombstoned = true
          fs.writeFileSync(intentPath, newer)
        }
      },
    }

    recoverSettingsAndJournalPair(tmpDir, {
      platform: 'win32',
      startupId: 'intent-tombstone-win-boot-3',
      durableFs,
    })

    expect(tombstoned).toBe(true)
    expect(fs.readFileSync(intentPath)).toEqual(newer)
    expect(fs.readdirSync(tmpDir).filter(name => name.startsWith(`${RESTORE_INTENT_FILE}.cleanup-`)))
      .toEqual([])
  })

  it('preserves a swapped tombstone whose inode and bytes do not match cleanup authority', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(240)])
    writeCorruptLivePair(tmpDir)
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const posixOps = simulatedPosixOps()
    const foreign = Buffer.from(JSON.stringify({
      version: 1,
      snapshotId: 'foreign-recovery-authority',
      settings: { size: 0, sha256: '1'.repeat(64) },
      journal: { size: 0, sha256: '1'.repeat(64) },
    }, null, 2), 'utf8')
    let swapped = false
    const durableFs: DurableFileOps = {
      ...posixOps,
      renameSync(source, destination) {
        if (!swapped && path.resolve(String(source)) === path.resolve(intentPath)) {
          const temporary = `${intentPath}.foreign`
          fs.writeFileSync(temporary, foreign)
          fs.renameSync(temporary, intentPath)
          swapped = true
        }
        posixOps.renameSync(source, destination)
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'linux',
      durableFs,
    }))
    const tombstones = fs.readdirSync(tmpDir)
      .filter(name => name.startsWith(`${RESTORE_INTENT_FILE}.cleanup-`))

    expect(swapped).toBe(true)
    expect(error.message).toMatch(/intent|tombstone|changed|identity|authority/i)
    expect(tombstones).toHaveLength(1)
    expect(fs.readFileSync(path.join(tmpDir, tombstones[0]))).toEqual(foreign)
  })

  it('reconciles a crash after canonical intent was renamed to its tombstone', () => {
    writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(241)])
    writeCorruptLivePair(tmpDir)
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const posixOps = simulatedPosixOps()
    let crashed = false
    const crashingFs: DurableFileOps = {
      ...posixOps,
      renameSync(source, destination) {
        posixOps.renameSync(source, destination)
        if (!crashed
          && path.resolve(String(source)) === path.resolve(intentPath)
          && path.basename(String(destination)).startsWith(`${RESTORE_INTENT_FILE}.cleanup-`)) {
          crashed = true
          throw new Error('simulated crash after intent tombstone rename')
        }
      },
    }

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'linux',
      durableFs: crashingFs,
    })).toThrow(/simulated crash after intent tombstone rename/i)
    expect(fs.existsSync(intentPath)).toBe(false)
    expect(fs.readdirSync(tmpDir).filter(name => name.startsWith(`${RESTORE_INTENT_FILE}.cleanup-`)))
      .toHaveLength(1)

    expect(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'linux',
      durableFs: posixOps,
    })).not.toThrow()
    expect(fs.existsSync(intentPath)).toBe(false)
    expect(fs.readdirSync(tmpDir).filter(name => name.startsWith(`${RESTORE_INTENT_FILE}.cleanup-`)))
      .toEqual([])
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

  it.each([
    ['backup manifest', 'backup'],
    ['live journal', 'live'],
  ] as const)('keeps legacy v1 backup and live evidence held across cleanup: %s', (
    _label,
    targetKind,
  ) => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(235)])
    const settingsBytes = fs.readFileSync(path.join(snapshot.snapshot, 'settings.json'))
    const journalBytes = snapshot.journal
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    fs.mkdirSync(stagingPath)
    fs.writeFileSync(path.join(stagingPath, 'settings.json'), settingsBytes)
    fs.writeFileSync(path.join(stagingPath, BABY_INFO_JOURNAL_FILE), journalBytes)
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    const legacyIntent = Buffer.from(JSON.stringify({
      version: 1,
      snapshotId: '2026-07-13_10-20-30',
      settings: { size: settingsBytes.byteLength, sha256: digest(settingsBytes) },
      journal: { size: journalBytes.byteLength, sha256: digest(journalBytes) },
    }, null, 2), 'utf8')
    fs.writeFileSync(intentPath, legacyIntent)
    writeCorruptLivePair(tmpDir)

    const targetPath = targetKind === 'backup'
      ? path.join(snapshot.snapshot, MANIFEST_FILE)
      : path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const targetBefore = targetKind === 'backup'
      ? fs.readFileSync(targetPath)
      : Buffer.from(journalBytes)
    const targetAfter = Buffer.from(targetBefore)
    targetAfter[0] = targetAfter[0] === 0x7b ? 0x5b : 0x7b
    let mutated = false
    const posixOps = simulatedPosixOps()
    const durableFs: DurableFileOps = {
      ...posixOps,
      openSync(target, flags, mode) {
        if (!mutated
          && path.resolve(String(target)) === path.resolve(tmpDir)
          && !fs.existsSync(stagingPath)
          && fs.existsSync(intentPath)) {
          const targetFd = fs.openSync(targetPath, 'r+')
          try {
            expect(fs.writeSync(targetFd, targetAfter, 0, targetAfter.byteLength, 0))
              .toBe(targetAfter.byteLength)
            mutated = true
          } finally {
            fs.closeSync(targetFd)
          }
        }
        return posixOps.openSync(target, flags, mode)
      },
    }

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'linux',
      durableFs,
    }))
    expect(mutated).toBe(true)
    expect(error.message).toMatch(/backup|manifest|live|journal|changed|identity|path/i)
    expect(error).toMatchObject({ originalsPreserved: false })
    expect(fs.readFileSync(intentPath)).toEqual(legacyIntent)
    expect(fs.existsSync(stagingPath)).toBe(false)
    expect(fs.readFileSync(targetPath)).toEqual(targetAfter)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(settingsBytes)
  })

  it('does not grant legacy cleanup authority to a forged v3 epoch transaction', () => {
    const snapshot = writeSnapshot(tmpDir, '2026-07-13_10-20-30', [mutation(236)])
    const settingsBytes = fs.readFileSync(path.join(snapshot.snapshot, 'settings.json'))
    const journalBytes = snapshot.journal
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), settingsBytes)
    fs.writeFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE), journalBytes)
    const stagingPath = path.join(tmpDir, RESTORE_STAGING_DIR)
    fs.mkdirSync(stagingPath)
    fs.writeFileSync(path.join(stagingPath, 'settings.json'), settingsBytes)
    fs.writeFileSync(path.join(stagingPath, BABY_INFO_JOURNAL_FILE), journalBytes)
    const forged = Buffer.from(JSON.stringify({
      version: 3,
      snapshotId: '2026-07-13_10-20-30',
      snapshotTimestamp: '1970-01-01T00:00:00.000Z',
      settings: { size: settingsBytes.byteLength, sha256: digest(settingsBytes) },
      journal: { size: journalBytes.byteLength, sha256: digest(journalBytes) },
      phase: 'primary-verified',
      windowsVerifiedStartups: 0,
      lastWindowsStartupId: '',
      forensicArchiveId: '',
      forensicManifest: null,
    }, null, 2), 'utf8')
    const intentPath = path.join(tmpDir, RESTORE_INTENT_FILE)
    fs.writeFileSync(intentPath, forged)
    fs.writeFileSync(path.join(stagingPath, 'restore-transaction.json'), forged)

    const error = captureThrown(() => recoverSettingsAndJournalPair(tmpDir, {
      platform: 'linux',
      durableFs: simulatedPosixOps(),
    }))
    expect(error.message).toMatch(/primary-verified|exact verified backup/i)
    expect(fs.readFileSync(intentPath)).toEqual(forged)
    expect(fs.existsSync(stagingPath)).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'settings.json'))).toEqual(settingsBytes)
    expect(fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE))).toEqual(journalBytes)
  })

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
