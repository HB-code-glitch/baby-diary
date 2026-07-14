import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => name === 'documents' ? path.join(tmpDir, 'documents') : tmpDir,
  },
}))

const NOW = new Date('2026-07-14T12:00:00Z')
const ONE_DAY_MS = 24 * 60 * 60 * 1000

function hoursAgo(hours: number): number {
  return NOW.getTime() - hours * 60 * 60 * 1000
}

describe('selectStaleTmpDirectoriesToSweep (pure)', () => {
  const alwaysAlive = () => true
  const alwaysDead = () => false

  it('sweeps a stale staging tmp directory (crash-orphaned, mtime > 24h)', async () => {
    const { selectStaleTmpDirectoriesToSweep } = await import('../electron/store/backup')
    const entries = [{ name: '2026-07-10_09-00-00.tmp-a1b2c3', mtimeMs: hoursAgo(25) }]
    expect(selectStaleTmpDirectoriesToSweep(entries, NOW, alwaysDead)).toEqual([
      '2026-07-10_09-00-00.tmp-a1b2c3',
    ])
  })

  it('keeps a fresh staging tmp directory (mtime within 24h, likely in-flight)', async () => {
    const { selectStaleTmpDirectoriesToSweep } = await import('../electron/store/backup')
    const entries = [{ name: '2026-07-14_11-30-00.tmp-a1b2c3', mtimeMs: hoursAgo(1) }]
    expect(selectStaleTmpDirectoriesToSweep(entries, NOW, alwaysDead)).toEqual([])
  })

  it('keeps a name that does not match either tmp-directory naming scheme, even if old', async () => {
    const { selectStaleTmpDirectoriesToSweep } = await import('../electron/store/backup')
    const entries = [{ name: 'aaaa-aa-aa_aa-aa-aa.tmp-a1b2c3', mtimeMs: hoursAgo(999) }]
    expect(selectStaleTmpDirectoriesToSweep(entries, NOW, alwaysDead)).toEqual([])
  })

  it('sweeps a stale evidence spool tmp directory when the owning pid is dead', async () => {
    const { selectStaleTmpDirectoriesToSweep } = await import('../electron/store/backup')
    const entries = [{ name: '.baby-info-backup.tmp-evidence-99999-xyz123', mtimeMs: hoursAgo(48) }]
    expect(selectStaleTmpDirectoriesToSweep(entries, NOW, alwaysDead)).toEqual([
      '.baby-info-backup.tmp-evidence-99999-xyz123',
    ])
  })

  it('keeps a stale-looking evidence spool tmp directory when the owning pid is alive', async () => {
    const { selectStaleTmpDirectoriesToSweep } = await import('../electron/store/backup')
    const entries = [{ name: '.baby-info-backup.tmp-evidence-99999-xyz123', mtimeMs: hoursAgo(48) }]
    expect(selectStaleTmpDirectoriesToSweep(entries, NOW, alwaysAlive)).toEqual([])
  })

  it('keeps a fresh evidence spool tmp directory regardless of pid liveness', async () => {
    const { selectStaleTmpDirectoriesToSweep } = await import('../electron/store/backup')
    const entries = [{ name: '.baby-info-backup.tmp-evidence-99999-xyz123', mtimeMs: hoursAgo(1) }]
    expect(selectStaleTmpDirectoriesToSweep(entries, NOW, alwaysDead)).toEqual([])
  })

  it('never sweeps a verified snapshot directory name, no matter how old', async () => {
    const { selectStaleTmpDirectoriesToSweep } = await import('../electron/store/backup')
    const entries = [{ name: '2020-01-01_00-00-00', mtimeMs: hoursAgo(365 * 24) }]
    expect(selectStaleTmpDirectoriesToSweep(entries, NOW, alwaysDead)).toEqual([])
  })

  it('never sweeps unrelated directory names', async () => {
    const { selectStaleTmpDirectoriesToSweep } = await import('../electron/store/backup')
    const entries = [
      { name: 'not-a-tmp-dir', mtimeMs: hoursAgo(999) },
      { name: '.git', mtimeMs: hoursAgo(999) },
      { name: 'README', mtimeMs: hoursAgo(999) },
    ]
    expect(selectStaleTmpDirectoriesToSweep(entries, NOW, alwaysDead)).toEqual([])
  })

  it('exactly 24h old is treated as still-recent (boundary is not stale)', async () => {
    const { selectStaleTmpDirectoriesToSweep } = await import('../electron/store/backup')
    const entries = [{ name: '2026-07-10_09-00-00.tmp-a1b2c3', mtimeMs: NOW.getTime() - ONE_DAY_MS }]
    expect(selectStaleTmpDirectoriesToSweep(entries, NOW, alwaysDead)).toEqual([])
  })
})

describe('BackupManager sweeps stale tmp directories at backup start (integration)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babydiary-stale-tmp-test-'))
    const settings = {
      baby: { name: 'Test', birthdate: '2025-01-01' },
      profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
      familyId: 'fam1',
      firebase: null,
    }
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(settings))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function ageDirectory(fullPath: string, hours: number): void {
    const past = new Date(Date.now() - hours * 60 * 60 * 1000)
    fs.utimesSync(fullPath, past, past)
  }

  it('removes crash-orphaned staging and evidence tmp dirs while preserving real snapshots', async () => {
    const { BackupManager } = await import('../electron/store/backup')
    const manager = new BackupManager(tmpDir)

    // First real backup produces one genuine verified snapshot directory.
    await manager.backup()
    const backupDir = manager.getBackupDir()
    const realSnapshots = fs.readdirSync(backupDir)
    expect(realSnapshots).toHaveLength(1)
    const genuineSnapshotName = realSnapshots[0]

    // Simulate crash leftovers directly inside the same backup root.
    const staleStaging = path.join(backupDir, '2026-01-01_00-00-00.tmp-deadbeef')
    fs.mkdirSync(staleStaging, { recursive: true })
    fs.writeFileSync(path.join(staleStaging, 'partial.txt'), 'incomplete')
    ageDirectory(staleStaging, 25)

    const staleEvidence = path.join(backupDir, '.baby-info-backup.tmp-evidence-999999-deadbeef')
    fs.mkdirSync(staleEvidence, { recursive: true })
    fs.writeFileSync(path.join(staleEvidence, 'marker.json'), '{}')
    ageDirectory(staleEvidence, 48)

    const freshStaging = path.join(backupDir, '2026-07-14_11-59-00.tmp-freshbeef')
    fs.mkdirSync(freshStaging, { recursive: true })
    // Leave freshStaging at its natural (just-created) mtime.

    // Backup timestamps have 1-second resolution; wait so the second cycle
    // gets a distinct destination name instead of colliding (EEXIST) with
    // the snapshot from the first backup() call above.
    await new Promise(resolve => setTimeout(resolve, 1100))

    // Second backup cycle should sweep the stale leftovers at its entry point.
    await manager.backup()

    const finalEntries = fs.readdirSync(backupDir)
    expect(finalEntries).not.toContain('2026-01-01_00-00-00.tmp-deadbeef')
    expect(finalEntries).not.toContain('.baby-info-backup.tmp-evidence-999999-deadbeef')
    expect(finalEntries).toContain(path.basename(freshStaging))
    expect(finalEntries).toContain(genuineSnapshotName)
    // Two real backups now exist (from the two manager.backup() calls above).
    const realCount = finalEntries.filter(name => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name)).length
    expect(realCount).toBe(2)
  })
})
