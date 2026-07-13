import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export type BackupDestination = 'userData' | 'documents'

export interface BackupFailure {
  destination: BackupDestination
  path: string
  message: string
  code?: string
}

export interface BackupResult {
  timestamp: string
  succeeded: BackupDestination[]
  failed: BackupFailure[]
}

export class BackupAllDestinationsError extends Error {
  readonly code = 'BACKUP_ALL_DESTINATIONS_FAILED' as const

  constructor(readonly failures: BackupFailure[]) {
    super('All configured backup destinations failed')
    this.name = 'BackupAllDestinationsError'
  }
}

export function resolveBackupDirectories(
  userDataPath: string,
  documentsPath: string,
  platform: NodeJS.Platform,
) {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix
  return {
    dataDir: pathImpl.join(userDataPath, 'data'),
    userDataBackupDir: pathImpl.join(userDataPath, 'backups'),
    documentsBackupDir: pathImpl.join(documentsPath, 'BabyDiary-백업'),
  }
}

/**
 * Parse a backup folder name (format: YYYY-MM-DD_HH-MM-SS) to a Date.
 * Returns null if the name does not match the expected pattern.
 */
function parseBackupName(name: string): Date | null {
  // Pattern: 2026-07-12_14-30-00
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [, year, month, day, hour, minute, second] = m
  const d = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second)
  ))
  return isNaN(d.getTime()) ? null : d
}

/**
 * Pure function: given a list of backup folder names and the current time,
 * return the names that should be deleted according to retention policy:
 *   - Keep ALL backups from the last 90 days.
 *   - For backups older than 90 days: keep only the NEWEST one per calendar month.
 *
 * Only operates on names matching the YYYY-MM-DD_HH-MM-SS pattern.
 * Never throws.
 */
export function selectBackupsToPrune(names: string[], now: Date): string[] {
  const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

  // Separate names into: recent (keep all) vs old (monthly keep-1)
  const oldCandidates: Array<{ name: string; date: Date }> = []
  for (const name of names) {
    const d = parseBackupName(name)
    if (!d) continue  // non-timestamp dirs are ignored
    if (d >= cutoff) continue  // within 90 days: keep always
    oldCandidates.push({ name, date: d })
  }

  // Group old candidates by calendar month key "YYYY-MM"
  const byMonth = new Map<string, Array<{ name: string; date: Date }>>()
  for (const entry of oldCandidates) {
    const key = `${entry.date.getUTCFullYear()}-${String(entry.date.getUTCMonth() + 1).padStart(2, '0')}`
    const group = byMonth.get(key) ?? []
    group.push(entry)
    byMonth.set(key, group)
  }

  const toPrune: string[] = []
  const groups = Array.from(byMonth.values())
  for (const group of groups) {
    // Sort newest-first; keep index 0, prune the rest
    group.sort((a: { name: string; date: Date }, b: { name: string; date: Date }) => b.date.getTime() - a.date.getTime())
    for (let i = 1; i < group.length; i++) {
      toPrune.push(group[i].name)
    }
  }

  return toPrune
}

export class BackupManager {
  private dataDir: string
  private userDataBackupDir: string
  private documentsBackupDir: string
  private lastBackupTime: string | null = null
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private backupInFlight: Promise<BackupResult> | null = null
  private platform: NodeJS.Platform

  constructor(
    userDataPath: string,
    options: { documentsPath?: string; platform?: NodeJS.Platform } = {},
  ) {
    this.platform = options.platform ?? process.platform
    // V4: use app.getPath('documents') instead of os.homedir()/Documents so
    // OneDrive-redirected Documents folders are resolved correctly on Windows.
    const directories = resolveBackupDirectories(
      userDataPath,
      options.documentsPath ?? app.getPath('documents'),
      this.platform,
    )
    this.dataDir = directories.dataDir
    this.userDataBackupDir = directories.userDataBackupDir
    this.documentsBackupDir = directories.documentsBackupDir
  }

  private copyFileDurably(source: string, destination: string): void {
    fs.copyFileSync(source, destination)
    // Windows requires a writable handle for FlushFileBuffers (fsync).
    const fd = fs.openSync(destination, 'r+')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  private syncDirectory(directory: string): void {
    // Windows does not expose directory handles through fs.openSync. File
    // contents are still fsynced before the same-volume atomic rename.
    if (this.platform === 'win32') return
    const fd = fs.openSync(directory, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  private copyDataFiles(destDir: string): void {
    if (!fs.existsSync(this.dataDir)) {
      return
    }

    fs.mkdirSync(destDir, { recursive: true })

    const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.jsonl'))
    for (const file of files) {
      const src = path.join(this.dataDir, file)
      const dest = path.join(destDir, file)
      this.copyFileDurably(src, dest)
    }
  }

  private copySettingsFile(destDir: string): void {
    // MF-02: also back up settings.json (baby name, birthdate, familyId, Firebase creds)
    const settingsSrc = path.join(path.dirname(this.dataDir), 'settings.json')
    if (fs.existsSync(settingsSrc)) {
      this.copyFileDurably(settingsSrc, path.join(destDir, 'settings.json'))
    }
  }

  private backupDestination(root: string, timestamp: string): string {
    fs.mkdirSync(root, { recursive: true })
    const finalPath = path.join(root, timestamp)
    if (fs.existsSync(finalPath)) {
      const collision = new Error(`Backup destination already exists: ${finalPath}`)
      ;(collision as NodeJS.ErrnoException).code = 'EEXIST'
      throw collision
    }
    const stagingPath = fs.mkdtempSync(path.join(root, `${timestamp}.tmp-`))
    try {
      this.copyDataFiles(stagingPath)
      this.copySettingsFile(stagingPath)
      this.syncDirectory(stagingPath)
      fs.renameSync(stagingPath, finalPath)
      this.syncDirectory(root)
      return finalPath
    } catch (error) {
      try {
        if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true })
      } catch (cleanupError) {
        console.error(`[Backup] Failed to clean staging directory ${stagingPath}:`, cleanupError)
      }
      throw error
    }
  }

  private toFailure(destination: BackupDestination, destinationPath: string, error: unknown): BackupFailure {
    return {
      destination,
      path: destinationPath,
      message: error instanceof Error ? error.message : String(error),
      code: (error as NodeJS.ErrnoException | undefined)?.code,
    }
  }

  private pruneUserDataBackups(): void {
    try {
      if (fs.existsSync(this.userDataBackupDir)) {
        const entries = fs.readdirSync(this.userDataBackupDir)
        const toPrune = selectBackupsToPrune(entries, new Date())
        for (const name of toPrune) {
          const fullPath = path.join(this.userDataBackupDir, name)
          try {
            fs.rmSync(fullPath, { recursive: true, force: true })
            console.log(`[Backup] Pruned old backup: ${name}`)
          } catch (rmErr) {
            console.error(`[Backup] Failed to prune ${name}:`, rmErr)
          }
        }
      }
    } catch (pruneErr) {
      console.error('[Backup] Prune scan failed (non-fatal):', pruneErr)
    }
  }

  private async backupOnce(): Promise<BackupResult> {
    const now = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const targets: Array<{ destination: BackupDestination; root: string }> = [
      { destination: 'userData', root: this.userDataBackupDir },
      { destination: 'documents', root: this.documentsBackupDir },
    ]
    const succeeded: BackupDestination[] = []
    const failed: BackupFailure[] = []

    for (const target of targets) {
      const finalPath = path.join(target.root, timestamp)
      try {
        const durablePath = this.backupDestination(target.root, timestamp)
        succeeded.push(target.destination)
        console.log(`[Backup] Backed up to ${durablePath}`)
      } catch (error) {
        failed.push(this.toFailure(target.destination, finalPath, error))
        console.error(`[Backup] Failed to backup to ${target.destination}:`, error)
      }
    }

    if (succeeded.length === 0) {
      throw new BackupAllDestinationsError(failed)
    }

    this.lastBackupTime = now.toISOString()
    // Prune only after a new userData snapshot is durable. A Documents-only
    // success must never remove the last known-good local backup.
    if (succeeded.includes('userData')) this.pruneUserDataBackups()
    return { timestamp: this.lastBackupTime, succeeded, failed }
  }

  backup(): Promise<BackupResult> {
    if (this.backupInFlight) return this.backupInFlight
    const operation = this.backupOnce()
    this.backupInFlight = operation
    const clear = () => {
      if (this.backupInFlight === operation) this.backupInFlight = null
    }
    void operation.then(clear, clear)
    return operation
  }

  start(): void {
    this.backup().catch(err => console.error('[Backup] Initial backup failed:', err))

    const SIX_HOURS = 6 * 60 * 60 * 1000
    this.intervalHandle = setInterval(() => {
      this.backup().catch(err => console.error('[Backup] Scheduled backup failed:', err))
    }, SIX_HOURS)
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  /** P21: Returns true if the periodic backup interval is currently active. */
  isRunning(): boolean {
    return this.intervalHandle !== null
  }

  getLastBackupTime(): string | null {
    return this.lastBackupTime
  }

  getBackupDir(): string {
    return this.userDataBackupDir
  }

  getDocumentsBackupDir(): string {
    return this.documentsBackupDir
  }
}
