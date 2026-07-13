import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  BabyInfoJournal,
  parseBabyInfoJournalBuffer,
} from '../electron/store/babyInfoJournal'
import { getBabyInfoMutationKey } from '../shared/babyInfoResolver'
import type { AppSettings, BabyInfoMutation } from '../shared/types'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => name === 'documents' ? path.join(tmpDir, 'documents') : tmpDir,
  },
}))

function writeJournalAwareSource(root: string, name = 'Baby'): AppSettings {
  const mutation: BabyInfoMutation = {
    mutationId: '30000000-0000-4000-8000-000000000001',
    familyId: 'fam1',
    babyName: name,
    babyBirthdate: '2025-01-01',
    logicalClock: 1,
    updatedAt: '2026-07-13T10:20:30.000Z',
    authorId: 'user-1',
    origin: 'user',
  }
  new BabyInfoJournal(root).ingest('fam1', [mutation], [])
  const settings: AppSettings = {
    baby: { name, birthdate: mutation.babyBirthdate },
    profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
    familyId: 'fam1',
    firebase: null,
    babyInfoJournal: {
      version: 1,
      projectedFamilyId: 'fam1',
      projectedWinnerKey: getBabyInfoMutationKey(mutation),
    },
    babyInfoRevision: 1,
  }
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings, null, 2))
  return settings
}

describe('BackupManager verified snapshot set', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babydiary-backup-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('publishes settings, root journal, nested event data, and a deterministic manifest', async () => {
    const dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'events-2026-07.jsonl'), '{"id":"e1","type":"pee"}\n')
    const sourceSettings = writeJournalAwareSource(tmpDir, 'Manifest baby')

    const { BackupManager } = await import('../electron/store/backup')
    const manager = new BackupManager(tmpDir)
    await manager.backup()

    const snapshots = fs.readdirSync(manager.getBackupDir())
    expect(snapshots).toHaveLength(1)
    const snapshotPath = path.join(manager.getBackupDir(), snapshots[0])
    expect(fs.readdirSync(snapshotPath).sort()).toEqual([
      'baby-info-journal-v1.jsonl',
      'data',
      'manifest.json',
      'settings.json',
    ])
    expect(fs.existsSync(path.join(snapshotPath, 'data', 'events-2026-07.jsonl'))).toBe(true)
    const restored = JSON.parse(fs.readFileSync(path.join(snapshotPath, 'settings.json'), 'utf8'))
    expect(restored.baby.name).toBe(sourceSettings.baby.name)

    const manifest = JSON.parse(fs.readFileSync(path.join(snapshotPath, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 1, source: 'baby-diary' })
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
      'settings.json',
      'baby-info-journal-v1.jsonl',
      'data/events-2026-07.jsonl',
    ])
    for (const file of manifest.files) {
      expect(file).toMatchObject({
        path: expect.any(String),
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    }
  })

  it('uses the exact same verified manifest contract in both destinations', async () => {
    writeJournalAwareSource(tmpDir, 'Both destinations')
    const { BackupManager } = await import('../electron/store/backup')
    const manager = new BackupManager(tmpDir)
    await manager.backup()

    const userSnapshot = path.join(manager.getBackupDir(), fs.readdirSync(manager.getBackupDir())[0])
    const docsRoot = manager.getDocumentsBackupDir()
    const docsSnapshot = path.join(docsRoot, fs.readdirSync(docsRoot)[0])
    for (const snapshot of [userSnapshot, docsSnapshot]) {
      expect(fs.existsSync(path.join(snapshot, 'settings.json'))).toBe(true)
      expect(fs.existsSync(path.join(snapshot, 'baby-info-journal-v1.jsonl'))).toBe(true)
      expect(fs.existsSync(path.join(snapshot, 'manifest.json'))).toBe(true)
    }
    expect(fs.readFileSync(path.join(docsSnapshot, 'manifest.json'), 'utf8'))
      .toBe(fs.readFileSync(path.join(userSnapshot, 'manifest.json'), 'utf8'))
  })

  it('fails closed when settings.json is absent', async () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true })
    const { BackupManager } = await import('../electron/store/backup')
    const manager = new BackupManager(tmpDir)
    await expect(manager.backup()).rejects.toMatchObject({
      code: 'BACKUP_ALL_DESTINATIONS_FAILED',
    })
  })

  it('keeps unlinked baby-info archives replayable in the verified backup journal', async () => {
    const journal = new BabyInfoJournal(tmpDir)
    journal.archiveUnlinkedPair('Former family baby', '2025-04-03', '2026-07-13T10:20:30.000Z')
    const settings: AppSettings = {
      baby: { name: '', birthdate: '' },
      profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
      familyId: '',
      firebase: null,
      babyInfoJournal: { version: 1, projectedFamilyId: '' },
      babyInfoRevision: 1,
    }
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(settings))

    const { BackupManager } = await import('../electron/store/backup')
    const manager = new BackupManager(tmpDir)
    await manager.backup()
    const snapshot = path.join(manager.getBackupDir(), fs.readdirSync(manager.getBackupDir())[0])
    const replayed = parseBabyInfoJournalBuffer(
      fs.readFileSync(path.join(snapshot, 'baby-info-journal-v1.jsonl')),
    )

    expect(replayed.listUnlinkedArchivePage({ limit: 10 }).items).toEqual([
      expect.objectContaining({
        babyName: 'Former family baby',
        babyBirthdate: '2025-04-03',
      }),
    ])
  })
})
