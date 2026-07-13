import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BABY_INFO_JOURNAL_FILE, BabyInfoJournal } from '../electron/store/babyInfoJournal'
import { SettingsStore } from '../electron/store/settings'
import { getBabyInfoMutationKey } from '../shared/babyInfoResolver'
import type { AppSettings, BabyInfoMutation } from '../shared/types'

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
    fs.rmSync(tmpDir, { recursive: true, force: true })
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
    expect(fs.readdirSync(tmpDir).filter(name => name.includes('.corrupt-')).length)
      .toBeGreaterThanOrEqual(2)
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
