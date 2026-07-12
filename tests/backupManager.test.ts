/**
 * tests/backupManager.test.ts
 * MF-02: BackupManager.backup() must include settings.json in both snapshot dirs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// We need to mock 'electron' since BackupManager imports app.getPath('documents')
import { vi } from 'vitest'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'documents') return path.join(tmpDir, 'documents')
      return tmpDir
    },
  },
}))

describe('BackupManager.backup() — MF-02 settings.json inclusion', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babydiary-backup-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('includes settings.json in the userData backup snapshot', async () => {
    // Setup: create data dir with a .jsonl file and settings.json in userData
    const dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'events-2026-07.jsonl'), '{"id":"e1","type":"pee"}\n')
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({
      baby: { name: '아기', birthdate: '2025-01-01' },
      familyId: 'fam1',
    }))

    // Dynamically import after mock is in place
    const { BackupManager } = await import('../electron/store/backup')
    const manager = new BackupManager(tmpDir)
    await manager.backup()

    // Find the created snapshot in userDataBackupDir
    const backupDir = manager.getBackupDir()
    const snapshots = fs.readdirSync(backupDir)
    expect(snapshots.length).toBeGreaterThan(0)

    const snapshotPath = path.join(backupDir, snapshots[0])
    const files = fs.readdirSync(snapshotPath)

    expect(files).toContain('events-2026-07.jsonl')
    expect(files).toContain('settings.json')

    // Verify settings.json content is intact
    const restored = JSON.parse(fs.readFileSync(path.join(snapshotPath, 'settings.json'), 'utf-8'))
    expect(restored.baby.name).toBe('아기')
    expect(restored.familyId).toBe('fam1')
  })

  it('includes settings.json in both snapshot destinations', async () => {
    const dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ baby: { name: 'Test' } }))

    const { BackupManager } = await import('../electron/store/backup')
    const manager = new BackupManager(tmpDir)
    await manager.backup()

    // userData backup
    const backupDir = manager.getBackupDir()
    const snapshots1 = fs.readdirSync(backupDir)
    expect(snapshots1.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(backupDir, snapshots1[0], 'settings.json'))).toBe(true)

    // Documents backup
    const docsBackupDir = manager.getDocumentsBackupDir()
    const snapshots2 = fs.readdirSync(docsBackupDir)
    expect(snapshots2.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(docsBackupDir, snapshots2[0], 'settings.json'))).toBe(true)
  })

  it('does not fail if settings.json does not exist', async () => {
    const dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    // No settings.json — should not throw

    const { BackupManager } = await import('../electron/store/backup')
    const manager = new BackupManager(tmpDir)
    await expect(manager.backup()).resolves.not.toThrow()
  })
})
