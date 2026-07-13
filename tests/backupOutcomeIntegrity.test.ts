import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronPath = vi.hoisted(() => ({ documents: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electronPath.documents },
}))

import {
  BackupAllDestinationsError,
  BackupManager,
  resolveBackupDirectories,
} from '../electron/store/backup'

const FIRST_NOW = new Date('2026-07-13T10:20:30.000Z')
const FIRST_STAMP = '2026-07-13_10-20-30'
const SECOND_NOW = new Date('2026-07-13T10:20:31.000Z')
const SECOND_STAMP = '2026-07-13_10-20-31'

function writeSourceData(userData: string) {
  const data = path.join(userData, 'data')
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(data, '2026-07.jsonl'), '{"safe":true}\n', 'utf8')
  fs.writeFileSync(path.join(userData, 'settings.json'), '{"familyId":"keep"}', 'utf8')
}

function precreateCollision(directory: string, stamp: string, value: string) {
  const final = path.join(directory, stamp)
  fs.mkdirSync(final, { recursive: true })
  fs.writeFileSync(path.join(final, 'sentinel.txt'), value, 'utf8')
  return final
}

describe('BackupManager destination outcomes and durability state', () => {
  let tempRoot: string
  let userData: string
  let documents: string
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIRST_NOW)
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-diary-backup-integrity-'))
    userData = path.join(tempRoot, 'user-data')
    documents = path.join(tempRoot, 'documents')
    electronPath.documents = documents
    writeSourceData(userData)
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    consoleError.mockRestore()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('resolves redirected Windows Documents and macOS paths with native semantics', () => {
    expect(resolveBackupDirectories(
      'C:\\Users\\A\\AppData\\Roaming\\baby-diary',
      'D:\\Users\\A\\OneDrive\\Documents',
      'win32',
    )).toEqual({
      dataDir: 'C:\\Users\\A\\AppData\\Roaming\\baby-diary\\data',
      userDataBackupDir: 'C:\\Users\\A\\AppData\\Roaming\\baby-diary\\backups',
      documentsBackupDir: 'D:\\Users\\A\\OneDrive\\Documents\\BabyDiary-백업',
    })
    expect(resolveBackupDirectories(
      '/Users/a/Library/Application Support/baby-diary',
      '/Users/a/Documents',
      'darwin',
    )).toEqual({
      dataDir: '/Users/a/Library/Application Support/baby-diary/data',
      userDataBackupDir: '/Users/a/Library/Application Support/baby-diary/backups',
      documentsBackupDir: '/Users/a/Documents/BabyDiary-백업',
    })
  })

  it('updates lastBackupTime when one durable destination succeeds and reports the other failure', async () => {
    const paths = resolveBackupDirectories(userData, documents, process.platform)
    const blockedDocuments = precreateCollision(paths.documentsBackupDir, FIRST_STAMP, 'do-not-overwrite')
    const manager = new BackupManager(userData, { documentsPath: documents })

    const result = await manager.backup()

    expect(result.succeeded).toEqual(['userData'])
    expect(result.failed.map(failure => failure.destination)).toEqual(['documents'])
    expect(manager.getLastBackupTime()).toBe(FIRST_NOW.toISOString())
    expect(fs.readFileSync(path.join(paths.userDataBackupDir, FIRST_STAMP, '2026-07.jsonl'), 'utf8')).toBe('{"safe":true}\n')
    expect(fs.readFileSync(path.join(paths.userDataBackupDir, FIRST_STAMP, 'settings.json'), 'utf8')).toBe('{"familyId":"keep"}')
    expect(fs.readFileSync(path.join(blockedDocuments, 'sentinel.txt'), 'utf8')).toBe('do-not-overwrite')
    expect(fs.readdirSync(paths.userDataBackupDir).some(name => name.includes('.tmp-'))).toBe(false)
  })

  it('rejects with structured destination failures and never advances time when both targets fail', async () => {
    const paths = resolveBackupDirectories(userData, documents, process.platform)
    const userExisting = precreateCollision(paths.userDataBackupDir, FIRST_STAMP, 'user-old')
    const docsExisting = precreateCollision(paths.documentsBackupDir, FIRST_STAMP, 'docs-old')
    const manager = new BackupManager(userData, { documentsPath: documents })

    let caught: unknown
    try {
      await manager.backup()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(BackupAllDestinationsError)
    expect(caught).toMatchObject({
      code: 'BACKUP_ALL_DESTINATIONS_FAILED',
      failures: [
        { destination: 'userData', path: path.join(paths.userDataBackupDir, FIRST_STAMP) },
        { destination: 'documents', path: path.join(paths.documentsBackupDir, FIRST_STAMP) },
      ],
    })
    expect(manager.getLastBackupTime()).toBeNull()
    expect(fs.readFileSync(path.join(userExisting, 'sentinel.txt'), 'utf8')).toBe('user-old')
    expect(fs.readFileSync(path.join(docsExisting, 'sentinel.txt'), 'utf8')).toBe('docs-old')
  })

  it('preserves the last successful snapshot and timestamp after a later total failure', async () => {
    const paths = resolveBackupDirectories(userData, documents, process.platform)
    const manager = new BackupManager(userData, { documentsPath: documents })
    await manager.backup()
    expect(manager.getLastBackupTime()).toBe(FIRST_NOW.toISOString())

    vi.setSystemTime(SECOND_NOW)
    precreateCollision(paths.userDataBackupDir, SECOND_STAMP, 'blocked-new-user')
    precreateCollision(paths.documentsBackupDir, SECOND_STAMP, 'blocked-new-docs')

    await expect(manager.backup()).rejects.toBeInstanceOf(BackupAllDestinationsError)
    expect(manager.getLastBackupTime()).toBe(FIRST_NOW.toISOString())
    expect(fs.readFileSync(path.join(paths.userDataBackupDir, FIRST_STAMP, '2026-07.jsonl'), 'utf8')).toBe('{"safe":true}\n')
    expect(fs.readFileSync(path.join(paths.documentsBackupDir, FIRST_STAMP, 'settings.json'), 'utf8')).toBe('{"familyId":"keep"}')
  })

  it('coalesces overlapping backup requests so they cannot collide on the same timestamp', async () => {
    const manager = new BackupManager(userData, { documentsPath: documents })
    const first = manager.backup()
    const second = manager.backup()

    expect(second).toBe(first)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })
})
